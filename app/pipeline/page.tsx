"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { StageIndicator } from "@/components/pipeline/stage-indicator";
import { PipelineStream } from "@/components/pipeline/pipeline-stream";
import { ApprovalDialog } from "@/components/pipeline/approval-dialog";
import { ScoreChart } from "@/components/eval/score-chart";
import { PipelineStateInspector, applyEventToInspector, INITIAL_INSPECTOR_STATE } from "@/components/pipeline/state-inspector";
import type { InspectorState } from "@/components/pipeline/state-inspector";
import type { PipelineStage } from "@/lib/types/agent";
import type { SSEEvent, ApprovalRequest, EvalResult } from "@/lib/agents/types";
import type { Topic, UserProfile, PostingRecord } from "@/lib/types/github-data";
import { resolveRemainingTopics } from "@/lib/skills/remaining-topic-resolver";

interface ApprovalData {
  pipelineId: string;
  previousTitle: string;
  proposedTitle: string;
  rationale: string;
  outline: string[];
}

interface ResultData {
  postId: string;
  title: string;
  wordCount: number;
  evalScore: number;
  pass: boolean;
  recommendations: string[];
}

// 주제 선택 방식
type TopicMode = "list" | "direct";

export default function PipelinePage() {
  // 설정
  const [userId, setUserId] = useState("");
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);

  const [topicMode, setTopicMode] = useState<TopicMode>("list");
  const [topics, setTopics] = useState<Topic[]>([]);
  const [posts, setPosts] = useState<PostingRecord[]>([]);
  const [selectedTopicId, setSelectedTopicId] = useState("");
  const [directTitle, setDirectTitle] = useState("");

  // 자동 승인 모드 (테스트용)
  const [autoApprove, setAutoApprove] = useState(false);

  // 파이프라인 상태
  const [stage, setStage] = useState<PipelineStage>("idle");
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [streamingBody, setStreamingBody] = useState("");
  const [approval, setApproval] = useState<ApprovalData | null>(null);
  const [result, setResult] = useState<ResultData | null>(null);
  const [evalScores, setEvalScores] = useState<EvalResult["scores"] | null>(null);
  const [running, setRunning] = useState(false);
  const [runningTitle, setRunningTitle] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [inspector, setInspector] = useState<InspectorState>(INITIAL_INSPECTOR_STATE);
  const esRef = useRef<EventSource | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 컴포넌트 언마운트 시 타이머 정리
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // 토픽 목록 + 발행 인덱스 동시 로드
  useEffect(() => {
    const t = Date.now();
    Promise.allSettled([
      fetch(`/api/github/topics?_t=${t}`).then((r) => r.json()) as Promise<{ topics: Topic[] }>,
      fetch(`/api/github/posts?limit=1000&_t=${t}`).then((r) => r.json()) as Promise<{ posts: PostingRecord[] }>,
    ]).then(([topicResult, postResult]) => {
      const postData = postResult.status === "fulfilled" ? postResult.value : { posts: [] };
      const topicData = topicResult.status === "fulfilled" ? topicResult.value : { topics: [] };
      // draft만 허용 — in-progress/published/archived 모두 제외
      setTopics((topicData.topics ?? []).filter((t) => t.status === "draft"));
      setPosts(postData.posts ?? []);
    });
  }, []);

  // 사용자 프로필 로드 (userId 입력 후 딜레이)
  useEffect(() => {
    if (!userId.trim()) { setProfile(null); return; }
    const timer = setTimeout(() => {
      setProfileLoading(true);
      fetch(`/api/github/profile?userId=${encodeURIComponent(userId.trim())}`)
        .then((r) => r.ok ? r.json() : null)
        .then((d: { profile: UserProfile } | null) => setProfile(d?.profile ?? null))
        .catch(() => setProfile(null))
        .finally(() => setProfileLoading(false));
    }, 600);
    return () => clearTimeout(timer);
  }, [userId]);

  const handleEvent = useCallback((event: SSEEvent) => {
    setEvents((prev) => [...prev, event]);
    setInspector((prev) => applyEventToInspector(prev, event));

    if (event.type === "stage_change") {
      setStage((event.data as { stage?: PipelineStage })?.stage ?? event.stage);
    }
    if (event.type === "token") {
      setStreamingBody((prev) => prev + ((event.data as { token?: string })?.token ?? ""));
    }
    if (event.type === "approval_required") {
      const approvalData = event.data as ApprovalData;
      // 자동 승인 모드: 즉시 approve 처리
      if (autoApprove) {
        fetch("/api/pipeline/approve", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pipelineId: approvalData.pipelineId, approved: true }),
        }).catch(() => {});
      } else {
        setApproval(approvalData);
      }
    }
    if (event.type === "result") {
      const d = event.data as ResultData;
      setResult(d);
      setRunning(false);
      setRunningTitle(null);
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      esRef.current?.close();
    }
    if (event.type === "rejected") {
      // 전략 거절 — 에러가 아니라 재시도 가능한 상태로 복귀
      setApproval(null);
      setRunning(false);
      setRunningTitle(null);
      setStage("idle");
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      esRef.current?.close();
    }
    if (event.type === "gate_blocked") {
      setRunning(false);
      setRunningTitle(null);
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      esRef.current?.close();
    }
    if (event.type === "error") {
      setRunning(false);
      setRunningTitle(null);
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      esRef.current?.close();
    }
  }, [autoApprove]);  

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

  const startPipeline = async () => {
    const uid = userId.trim();
    if (!uid) return;
    if (topicMode === "list" && !selectedTopicId) return;
    if (topicMode === "direct" && !directTitle.trim()) return;

    setEvents([]);
    setStreamingBody("");
    setApproval(null);
    setResult(null);
    setEvalScores(null);
    setStage("idle");
    setRunning(true);

    // 선택 주제 제목 결정 (inspector용)
    const selectedTitle =
      topicMode === "list"
        ? topics.find((t) => t.topicId === selectedTopicId)?.title ?? selectedTopicId
        : directTitle.trim();

    setRunningTitle(selectedTitle);
    setInspector({
      ...INITIAL_INSPECTOR_STATE,
      selected_topic: selectedTitle,
      remaining_topics_count: availableTopics.length,
    });

    const topicId = await resolveTopicId();
    if (!topicId) { setRunning(false); return; }

    // 타이머 시작
    setElapsed(0);
    timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);

    fetch("/api/pipeline/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topicId, userId: uid }),
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
  };

  const handleApprove = async (req: ApprovalRequest) => {
    const res = await fetch("/api/pipeline/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      // 승인 전달 실패 — 파이프라인이 이미 종료됐거나 서버가 재시작됨
      setApproval(null);
      setRunning(false);
      setStage("idle");
      setEvents((prev) => [
        ...prev,
        {
          type: "error",
          stage: "failed",
          data: { message: "승인 전달 실패: 서버가 재시작됐을 수 있습니다. 다시 시도해 주세요." },
          timestamp: new Date().toISOString(),
        },
      ]);
      return;
    }
    setApproval(null);
    setInspector((prev) => ({ ...prev, approval_received: req.approved }));
    if (!req.approved) setRunning(false);
  };

  const canStart = (() => {
    if (!userId.trim() || running) return false;
    if (topicMode === "list") return !!selectedTopicId;
    return !!directTitle.trim();
  })();

  // RemainingTopicResolver: 발행 인덱스와 cross-check (topicId 비교 금지)
  const currentUid = userId.trim().toLowerCase();
  const userTopics = currentUid
    ? topics.filter((t) => t.assignedUserId?.toLowerCase() === currentUid)
    : topics;
  const { remaining: availableTopics } = resolveRemainingTopics(userTopics, posts);

  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900">글쓰기 실행</h1>
        <p className="text-zinc-500 mt-1 text-sm">전략 수립 완료 → 승인 후 본문 작성 시작</p>
      </div>

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
            {!profileLoading && userId.trim() && !profile && (
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
      {(running || result) && (
        <div className="mb-6">
          <PipelineStateInspector state={inspector} />
        </div>
      )}

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

          {evalScores && (
            <ScoreChart scores={evalScores} aggregateScore={result.evalScore} />
          )}

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
