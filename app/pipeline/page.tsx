"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { StageIndicator } from "@/components/pipeline/stage-indicator";
import { PipelineStream } from "@/components/pipeline/pipeline-stream";
import { ApprovalDialog } from "@/components/pipeline/approval-dialog";
import { PipelineStateInspector, applyEventToInspector } from "@/components/pipeline/state-inspector";
import { usePipelineStore } from "@/lib/store/pipeline-store";
import type { SSEEvent, ApprovalRequest, StrategyPlanResult } from "@/lib/agents/types";
import type { Topic, UserProfile, PostingRecord } from "@/lib/types/github-data";
import { resolveRemainingTopics } from "@/lib/skills/remaining-topic-resolver";

interface ApprovalData {
  pipelineId: string;
  topicId: string;
  previousTitle: string;
  proposedTitle: string;
  rationale: string;
  outline: string[];
  strategy: StrategyPlanResult; // write phase에서 사용
}

interface ResultData {
  postId: string;
  title: string;
  wordCount: number;
  evalScore: number;
  pass: boolean;
  recommendations: string[];
}

export default function PipelinePage() {
  // ── Zustand store (페이지 이탈 후 복원) ──────────────────────
  const userId = usePipelineStore((s) => s.userId);
  const topicMode = usePipelineStore((s) => s.topicMode);
  const selectedTopicId = usePipelineStore((s) => s.selectedTopicId);
  const directTitle = usePipelineStore((s) => s.directTitle);
  const autoApprove = usePipelineStore((s) => s.autoApprove);
  const stage = usePipelineStore((s) => s.stage);
  const events = usePipelineStore((s) => s.events);
  const streamingBody = usePipelineStore((s) => s.streamingBody);
  const result = usePipelineStore((s) => s.result);
  const inspector = usePipelineStore((s) => s.inspector);
  const runningTitle = usePipelineStore((s) => s.runningTitle);

  const setUserId = usePipelineStore((s) => s.setUserId);
  const setTopicMode = usePipelineStore((s) => s.setTopicMode);
  const setSelectedTopicId = usePipelineStore((s) => s.setSelectedTopicId);
  const setDirectTitle = usePipelineStore((s) => s.setDirectTitle);
  const setAutoApprove = usePipelineStore((s) => s.setAutoApprove);
  const setStage = usePipelineStore((s) => s.setStage);
  const appendEvent = usePipelineStore((s) => s.appendEvent);
  const setEvents = usePipelineStore((s) => s.setEvents);
  const appendStreamingToken = usePipelineStore((s) => s.appendStreamingToken);
  const setStreamingBody = usePipelineStore((s) => s.setStreamingBody);
  const setResult = usePipelineStore((s) => s.setResult);
  const setInspector = usePipelineStore((s) => s.setInspector);
  const setRunningTitle = usePipelineStore((s) => s.setRunningTitle);
  const resetRun = usePipelineStore((s) => s.resetRun);

  // ── 로컬 상태 (이탈 시 초기화해도 무방) ─────────────────────
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [posts, setPosts] = useState<PostingRecord[]>([]);
  const [approval, setApproval] = useState<ApprovalData | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [stuckCount, setStuckCount] = useState(0);
  const [recovering, setRecovering] = useState(false);
  const [pipelineError, setPipelineError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 컴포넌트 언마운트 시 타이머 정리
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // pollRef는 더 이상 사용하지 않음 — 2단계 파이프라인에서 승인은 클라이언트에서 처리
  // (제거하면 기존 refs 참조 오류 발생하므로 useEffect만 비워둠)
  useEffect(() => {
    return () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };
  }, []);

  // 토픽 목록 + 발행 인덱스 + stuck count 동시 로드
  const reloadTopics = () => {
    const t = Date.now();
    Promise.allSettled([
      fetch(`/api/github/topics?_t=${t}`).then((r) => r.json()) as Promise<{ topics: Topic[] }>,
      fetch(`/api/github/posts?limit=1000&_t=${t}`).then((r) => r.json()) as Promise<{ posts: PostingRecord[] }>,
      fetch(`/api/github/topics/recover-stuck?_t=${t}`).then((r) => r.json()) as Promise<{ count: number }>,
    ]).then(([topicResult, postResult, stuckResult]) => {
      const postData = postResult.status === "fulfilled" ? postResult.value : { posts: [] };
      const topicData = topicResult.status === "fulfilled" ? topicResult.value : { topics: [] };
      const stuckData = stuckResult.status === "fulfilled" ? stuckResult.value : { count: 0 };
      // draft만 허용 — in-progress/published/archived 모두 제외
      setTopics((topicData.topics ?? []).filter((t) => t.status === "draft"));
      setPosts(postData.posts ?? []);
      setStuckCount(stuckData.count ?? 0);
    });
  };

  useEffect(() => { reloadTopics(); }, []);

  // 사용자 프로필 로드 (userId 입력 후 딜레이)
  useEffect(() => {
    if (!userId.trim()) { setProfile(null); setProfileError(null); return; }
    const timer = setTimeout(() => {
      setProfileLoading(true);
      setProfileError(null);
      fetch(`/api/github/profile?userId=${encodeURIComponent(userId.trim())}`)
        .then(async (r) => {
          const json = await r.json() as { profile?: UserProfile; error?: string };
          if (r.ok) { setProfile(json.profile ?? null); }
          else { setProfile(null); setProfileError(json.error ?? "프로필 조회 실패"); }
        })
        .catch((e) => { setProfile(null); setProfileError(e instanceof Error ? e.message : "네트워크 오류"); })
        .finally(() => setProfileLoading(false));
    }, 600);
    return () => clearTimeout(timer);
  }, [userId]);

  const handleEvent = useCallback((event: SSEEvent) => {
    appendEvent(event);
    setInspector((prev) => applyEventToInspector(prev, event));

    if (event.type === "stage_change") {
      setStage((event.data as { stage?: import("@/lib/types/agent").PipelineStage })?.stage ?? event.stage);
      // pipelineId는 approval 데이터를 통해 전달됨 — 여기선 추적 불필요
    }
    if (event.type === "token") {
      appendStreamingToken((event.data as { token?: string })?.token ?? "");
    }
    if (event.type === "approval_required") {
      // strategy phase 완료 — approval 데이터에 strategy 포함
      const d = event.data as {
        pipelineId: string;
        previousTitle: string;
        proposedTitle: string;
        rationale: string;
        outline: string[];
        strategy: StrategyPlanResult;
      };
      const approvalData: ApprovalData = {
        pipelineId: d.pipelineId,
        topicId: (event.data as Record<string, unknown>).__topicId as string ?? "",
        previousTitle: d.previousTitle,
        proposedTitle: d.proposedTitle,
        rationale: d.rationale,
        outline: d.outline,
        strategy: d.strategy,
      };
      // autoApprove 여부는 위 useEffect가 처리 — 여기선 항상 setApproval만
      setApproval(approvalData);
    }
    if (event.type === "result") {
      const d = event.data as ResultData;
      setResult(d);
      setRunning(false);
      setRunningTitle(null);
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    }
    if (event.type === "gate_blocked") {
      const d = event.data as {
        postId: string;
        evalScore: number;
        recommendations: string[];
        draft?: { title: string; wordCount: number };
      };
      setStage("gate_blocked");
      setResult({
        postId: d.postId,
        title: d.draft?.title ?? "",
        wordCount: d.draft?.wordCount ?? 0,
        evalScore: d.evalScore,
        pass: false,
        recommendations: d.recommendations ?? [],
      });
      setRunning(false);
      setRunningTitle(null);
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    }
    if (event.type === "error") {
      const msg = (event.data as { message?: string })?.message ?? "파이프라인 오류가 발생했습니다.";
      setPipelineError(msg);
      setStage("idle");
      setRunning(false);
      setRunningTitle(null);
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    }
  }, [appendEvent, setInspector, setStage, appendStreamingToken, setResult, setRunningTitle]);

  // "직접 주제 입력" 모드: 먼저 draft 토픽을 생성하고 그 ID를 사용
  const resolveTopicId = async (): Promise<string | null> => {
    if (topicMode === "list") return selectedTopicId || null;

    const title = directTitle.trim();
    if (!title) return null;

    const res = await fetch("/api/github/topics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, assignedUserId: userId.trim() }),
    });
    if (!res.ok) return null;
    const json = await res.json() as { topic: Topic };
    return json.topic.topicId;
  };

  // write phase 시작 — 승인 후 호출
  const startWritePhase = useCallback((approvalData: ApprovalData, uid: string) => {
    fetch("/api/pipeline/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pipelineId: approvalData.pipelineId,
        topicId: approvalData.topicId,
        userId: uid,
        strategy: approvalData.strategy,
      }),
    }).then((res) => {
      if (!res.body) { setRunning(false); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const read = () => {
        reader.read().then(({ done, value }) => {
          if (done) { setRunning(false); return; }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try { handleEvent(JSON.parse(line.slice(6)) as SSEEvent); } catch { /* ignore */ }
            }
          }
          read();
        }).catch(() => setRunning(false));
      };
      read();
    }).catch(() => setRunning(false));
  }, [handleEvent]);

  // 자동 승인 처리 — approval 상태가 설정되고 autoApprove이면 즉시 write phase 시작
  const autoApproveRef = useRef(autoApprove);
  useEffect(() => { autoApproveRef.current = autoApprove; }, [autoApprove]);

  useEffect(() => {
    if (!approval || !autoApproveRef.current) return;
    const uid = userId.trim();
    setApproval(null);
    setInspector((prev) => ({ ...prev, approval_received: true }));
    startWritePhase(approval, uid);
  // approval 변경 시에만 실행 — startWritePhase/userId는 stable refs
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approval]);

  const startPipeline = async () => {
    const uid = userId.trim();
    if (!uid) return;
    if (topicMode === "list" && !selectedTopicId) return;
    if (topicMode === "direct" && !directTitle.trim()) return;

    resetRun();
    setEvents([]);
    setStreamingBody("");
    setResult(null);
    setStage("idle");
    setApproval(null);
setPipelineError(null);
    setRunning(true);

    const selectedTitle =
      topicMode === "list"
        ? topics.find((t) => t.topicId === selectedTopicId)?.title ?? selectedTopicId
        : directTitle.trim();

    setRunningTitle(selectedTitle);
    setInspector({
      ...usePipelineStore.getState().inspector,
      selected_topic: selectedTitle,
      remaining_topics_count: availableTopics.length,
    });

    const topicId = await resolveTopicId();
    if (!topicId) { setRunning(false); return; }

    setElapsed(0);
    timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);

    // Phase 1: 전략 수립 (approval_required 이벤트까지만)
    // approval_required를 받으면 setApproval()이 호출되고 스트림은 자동으로 닫힘
    // Phase 2는 handleApprove에서 시작
    fetch("/api/pipeline/strategy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topicId, userId: uid }),
    }).then((res) => {
      if (!res.body) { setRunning(false); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let topicIdInjected = false;
      const read = () => {
        reader.read().then(({ done, value }) => {
          if (done) {
            // 스트림 종료 — approval 다이얼로그가 열려 있으면 running 유지 (write phase 대기)
            // approval 없이 종료(에러/타임아웃) → running 해제
            setApproval((current) => {
              if (!current) {
                // approval이 없으면 에러로 종료된 것 — running 해제
                setRunning(false);
                if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
              }
              return current;
            });
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const event = JSON.parse(line.slice(6)) as SSEEvent;
                // approval_required 이벤트에 topicId 주입 (handleApprove에서 필요)
                if (event.type === "approval_required" && !topicIdInjected) {
                  topicIdInjected = true;
                  (event.data as Record<string, unknown>).__topicId = topicId;
                }
                handleEvent(event);
              } catch { /* ignore */ }
            }
          }
          read();
        }).catch(() => setRunning(false));
      };
      read();
    }).catch(() => setRunning(false));
  };

  const handleApprove = async (req: ApprovalRequest) => {
    const uid = userId.trim();
    if (!req.approved) {
      setApproval(null);
      setRunning(false);
      setRunningTitle(null);
      setStage("idle");
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }

    // 승인 — approval 상태에서 strategy와 topicId 꺼내서 write phase 시작
    const currentApproval = approval;
    setApproval(null);
    setInspector((prev) => ({ ...prev, approval_received: true }));

    if (!currentApproval) return;
    startWritePhase(currentApproval, uid);
  };

  const canStart = (() => {
    if (!userId.trim() || running) return false;
    if (topicMode === "list") return !!selectedTopicId;
    return !!directTitle.trim();
  })();

  const handleRecoverStuck = async () => {
    setRecovering(true);
    try {
      const res = await fetch("/api/github/topics/recover-stuck", { method: "POST" });
      if (res.ok) {
        reloadTopics();
      }
    } finally {
      setRecovering(false);
    }
  };

  const currentUid = userId.trim().toLowerCase();
  const userTopics = currentUid
    ? topics.filter((t) => t.assignedUserId?.toLowerCase() === currentUid)
    : topics;
  const { remaining: availableTopics } = resolveRemainingTopics(userTopics, posts);

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900">글쓰기 실행</h1>
        <p className="text-zinc-500 mt-1 text-sm">승인 후 본문 작성 시작</p>
      </div>

      {/* ── 멈춤 토픽 복구 경고 ────────────────────────────── */}
      {stuckCount > 0 && (
        <div className="mb-4 flex items-center justify-between bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
          <p className="text-sm text-amber-800">
            <span className="font-semibold">{stuckCount}개 토픽</span>이 이전 파이프라인 실패로 진행 중 상태에 멈춰 있습니다.
          </p>
          <button
            onClick={handleRecoverStuck}
            disabled={recovering}
            className="ml-4 px-3 py-1 bg-amber-600 text-white text-xs font-semibold rounded hover:bg-amber-700 disabled:opacity-50 transition-colors whitespace-nowrap"
          >
            {recovering ? "복구 중..." : "일괄 복구"}
          </button>
        </div>
      )}

      {/* ── 파이프라인 에러 배너 ──────────────────────────── */}
      {pipelineError && (
        <div className="mb-4 flex items-start justify-between bg-red-50 border border-red-200 rounded-lg px-4 py-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-red-700">글쓰기 실패</p>
            <p className="text-xs text-red-600 mt-0.5 break-words">{pipelineError}</p>
          </div>
          <button
            onClick={() => setPipelineError(null)}
            className="ml-3 text-red-400 hover:text-red-600 shrink-0 text-lg leading-none"
          >
            ×
          </button>
        </div>
      )}

      {/* ── 실행 설정 ─────────────────────────────────────── */}
      <div className="bg-white border border-zinc-200 rounded-xl p-5 mb-6 space-y-5">

        {/* 사용자 선택 */}
        <div>
          <label className="block text-xs font-semibold text-zinc-600 mb-1">사용자 선택</label>
          <div className="flex items-center gap-3">
            <input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="사용자 ID 입력"
              disabled={running}
              className="flex-1 border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
            />
            {profileLoading && <span className="text-xs text-zinc-400">확인 중...</span>}
            {!profileLoading && profile && (
              <span className="text-xs text-emerald-600 font-medium">{profile.displayName}</span>
            )}
            {!profileLoading && userId.trim() && !profile && profileError && (
              <span className="text-xs text-red-500" title={profileError}>오류: {profileError}</span>
            )}
            {!profileLoading && userId.trim() && !profile && !profileError && (
              <span className="text-xs text-zinc-400">프로필 없음</span>
            )}
          </div>
        </div>

        {/* 블로그 선택 */}
        <div>
          <label className="block text-xs font-semibold text-zinc-600 mb-1">블로그</label>
          {profile?.naverBlogUrl ? (
            <div className="flex items-center gap-2 bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2">
              <span className="text-xs text-zinc-500">네이버 블로그</span>
              <a
                href={profile.naverBlogUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-blue-600 hover:underline truncate"
              >
                {profile.naverBlogUrl}
              </a>
            </div>
          ) : (
            <div className="bg-zinc-50 border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-400">
              사용자 ID를 입력하면 블로그 정보가 표시됩니다.
            </div>
          )}
        </div>

        {/* 주제 선택 방식 */}
        <div>
          <label className="block text-xs font-semibold text-zinc-600 mb-2">주제 선택 방식</label>
          <div className="flex gap-2 mb-3">
            <button
              onClick={() => setTopicMode("list")}
              disabled={running}
              className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors disabled:opacity-50 ${
                topicMode === "list"
                  ? "bg-zinc-900 text-white"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
              }`}
            >
              글목록에서 선택
            </button>
            <button
              onClick={() => setTopicMode("direct")}
              disabled={running}
              className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors disabled:opacity-50 ${
                topicMode === "direct"
                  ? "bg-zinc-900 text-white"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
              }`}
            >
              직접 주제 입력
            </button>
          </div>

          {topicMode === "list" ? (
            <div>
              <select
                value={selectedTopicId}
                onChange={(e) => setSelectedTopicId(e.target.value)}
                disabled={running}
                className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-900 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              >
                <option value="">글목록에서 주제를 선택하세요</option>
                {availableTopics.map((t) => (
                  <option key={t.topicId} value={t.topicId} className="text-zinc-900">
                    {t.title}
                  </option>
                ))}
              </select>
              {availableTopics.length === 0 && (
                <p className="text-xs text-zinc-400 mt-1.5">
                  {userId.trim()
                    ? `'${userId.trim()}' 사용자에게 배정된 주제가 없습니다.`
                    : <>글목록이 비어 있습니다. 먼저 <a href="/topics" className="text-blue-500 hover:underline">글목록</a>에서 주제를 등록해 주세요.</>
                  }
                </p>
              )}
            </div>
          ) : (
            <div>
              <input
                value={directTitle}
                onChange={(e) => setDirectTitle(e.target.value)}
                placeholder="예: 서울 카페 베스트 10 — 2024 최신판"
                disabled={running}
                className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50"
              />
              <p className="text-xs text-zinc-400 mt-1.5">
                입력한 주제로 즉시 글쓰기를 시작합니다. 글목록에 새 항목으로 자동 등록됩니다.
              </p>
            </div>
          )}
        </div>

        {/* 자동 승인 토글 */}
        <label className="flex items-center gap-2 text-xs text-zinc-500 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={autoApprove}
            onChange={(e) => setAutoApprove(e.target.checked)}
            disabled={running}
            className="rounded"
          />
          <span>자동 승인 모드 <span className="text-zinc-400">(테스트용 — 전략 검토 없이 즉시 진행)</span></span>
        </label>

        {/* 실행 버튼 */}
        <button
          onClick={startPipeline}
          disabled={!canStart}
          className="w-full py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {running ? "글쓰기 진행 중..." : "글쓰기 시작"}
        </button>

      </div>

      {/* 타임아웃 카운트다운 — 실행 중 항상 표시 */}
      {running && (
        <div className={`rounded-xl p-4 mb-6 flex items-center justify-between ${elapsed > 240 ? "bg-red-50 border border-red-200" : "bg-blue-50 border border-blue-200"}`}>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-base animate-pulse">⏱</span>
            <span className={`text-sm font-medium truncate ${elapsed > 240 ? "text-red-700" : "text-blue-700"}`}>
              {runningTitle ?? "글쓰기 진행 중..."}
            </span>
          </div>
          <div className="ml-4 shrink-0 text-right">
            <span className={`text-lg font-mono font-bold ${elapsed > 240 ? "text-red-600" : "text-blue-600"}`}>
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
            </span>
            <span className={`text-xs ml-1 ${elapsed > 240 ? "text-red-400" : "text-blue-400"}`}>/ 5:00</span>
          </div>
        </div>
      )}

      {/* 단계 표시 */}
      {stage !== "idle" && (
        <div className="bg-white border border-zinc-200 rounded-xl p-5 mb-6 overflow-x-auto">
          <StageIndicator currentStage={stage} />
        </div>
      )}

      {/* 파이프라인 상태 인스펙터 */}
      <div className="mb-6">
        <PipelineStateInspector state={inspector} />
      </div>

      {/* 스트리밍 로그 */}
      {(events.length > 0 || streamingBody) && (
        <div className="mb-6">
          <PipelineStream events={events} streamingBody={streamingBody} />
        </div>
      )}

      {/* 승인 다이얼로그 */}
      {approval && (
        <ApprovalDialog
          pipelineId={approval.pipelineId}
          previousTitle={approval.previousTitle}
          proposedTitle={approval.proposedTitle}
          rationale={approval.rationale}
          outline={approval.outline}
          onApprove={handleApprove}
          onReject={() => handleApprove({ pipelineId: approval.pipelineId, approved: false })}
        />
      )}

      {/* 결과 */}
      {result && (
        <div className="space-y-4">
          <div className={`border rounded-xl p-5 ${result.pass ? "bg-emerald-50 border-emerald-200" : "bg-amber-50 border-amber-200"}`}>
            <p className={`font-semibold text-sm mb-1 ${result.pass ? "text-emerald-700" : "text-amber-700"}`}>
              {result.pass ? "✓ 글쓰기 완료" : "⚠ 완료 — 평가 점수 미달"}
            </p>
            <p className="text-zinc-800 font-medium">{result.title}</p>
            <p className="text-xs text-zinc-500 mt-0.5">
              {result.wordCount.toLocaleString()}자 · 평가 점수 {result.evalScore}점
            </p>
          </div>


          {result.recommendations.length > 0 && (
            <div className="bg-white border border-zinc-200 rounded-xl p-4">
              <p className="text-xs font-semibold text-zinc-600 mb-2">개선 권고사항</p>
              <ul className="space-y-1">
                {result.recommendations.map((r, i) => (
                  <li key={i} className="text-sm text-zinc-700 flex gap-2">
                    <span className="text-zinc-400">•</span> {r}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
