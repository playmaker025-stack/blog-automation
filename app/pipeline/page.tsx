"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { StageIndicator } from "@/components/pipeline/stage-indicator";
import { ApprovalDialog } from "@/components/pipeline/approval-dialog";
import { PipelineStateInspector } from "@/components/pipeline/state-inspector";
import { usePipelineStore } from "@/lib/store/pipeline-store";
import { pipelineRunner } from "@/lib/pipeline-runner";
import type { BatchItemStatus } from "@/lib/pipeline-runner";
import type { ApprovalRequest, SSEEvent } from "@/lib/agents/types";
import type { Topic, UserProfile, PostingRecord } from "@/lib/types/github-data";
import { resolveRemainingTopics } from "@/lib/skills/remaining-topic-resolver";

export default function PipelinePage() {
  // ── Zustand store ─────────────────────────────────────────────
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
  const running = usePipelineStore((s) => s.running);
  const runStartedAt = usePipelineStore((s) => s.runStartedAt);
  const approval = usePipelineStore((s) => s.approval);
  const pipelineError = usePipelineStore((s) => s.pipelineError);

  const setUserId = usePipelineStore((s) => s.setUserId);
  const setTopicMode = usePipelineStore((s) => s.setTopicMode);
  const setSelectedTopicId = usePipelineStore((s) => s.setSelectedTopicId);
  const setDirectTitle = usePipelineStore((s) => s.setDirectTitle);
  const setAutoApprove = usePipelineStore((s) => s.setAutoApprove);
  const setEvents = usePipelineStore((s) => s.setEvents);
  const setStreamingBody = usePipelineStore((s) => s.setStreamingBody);
  const setInspector = usePipelineStore((s) => s.setInspector);
  const setPipelineError = usePipelineStore((s) => s.setPipelineError);
  const resetRun = usePipelineStore((s) => s.resetRun);

  // ── 로컬 상태 ─────────────────────────────────────────────────
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [posts, setPosts] = useState<PostingRecord[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [stuckCount, setStuckCount] = useState(0);
  const [recovering, setRecovering] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // ── 배치 상태 ─────────────────────────────────────────────────
  const [execMode, setExecMode] = useState<"single" | "batch">("single");
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchQueue, setBatchQueue] = useState<BatchItemStatus[]>([]);

  // ── 타이머 (runStartedAt 기반) ────────────────────────────────
  useEffect(() => {
    if (running && runStartedAt) {
      const tick = () => setElapsed(Math.floor((Date.now() - runStartedAt) / 1000));
      tick();
      timerRef.current = setInterval(tick, 1000);
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      if (!running) setElapsed(0);
    }
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  }, [running, runStartedAt]);

  // ── 이벤트 로그 자동 스크롤 ──────────────────────────────────
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events]);

  // ── 본문 스트리밍 자동 스크롤 ────────────────────────────────
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [streamingBody]);

  // ── 토픽/포스트 목록 로드 ────────────────────────────────────
  const reloadTopics = useCallback(() => {
    const t = Date.now();
    Promise.allSettled([
      fetch(`/api/github/topics?_t=${t}`).then((r) => r.json()) as Promise<{ topics: Topic[] }>,
      fetch(`/api/github/posts?limit=1000&_t=${t}`).then((r) => r.json()) as Promise<{ posts: PostingRecord[] }>,
      fetch(`/api/github/topics/recover-stuck?_t=${t}`).then((r) => r.json()) as Promise<{ count: number }>,
    ]).then(([topicResult, postResult, stuckResult]) => {
      setTopics((topicResult.status === "fulfilled" ? topicResult.value.topics : null) ?? []);
      setPosts((postResult.status === "fulfilled" ? postResult.value.posts : null) ?? []);
      setStuckCount((stuckResult.status === "fulfilled" ? stuckResult.value.count : null) ?? 0);
    });
  }, []);

  useEffect(() => { reloadTopics(); }, [reloadTopics]);

  // ── 사용자 프로필 ────────────────────────────────────────────
  useEffect(() => {
    if (!userId.trim()) { setProfile(null); setProfileError(null); return; }
    const timer = setTimeout(() => {
      setProfileLoading(true);
      setProfileError(null);
      fetch(`/api/github/profile?userId=${encodeURIComponent(userId.trim())}`)
        .then(async (r) => {
          const json = await r.json() as { profile?: UserProfile; error?: string };
          if (r.ok) setProfile(json.profile ?? null);
          else { setProfile(null); setProfileError(json.error ?? "프로필 조회 실패"); }
        })
        .catch((e) => { setProfile(null); setProfileError(e instanceof Error ? e.message : "네트워크 오류"); })
        .finally(() => setProfileLoading(false));
    }, 600);
    return () => clearTimeout(timer);
  }, [userId]);

  // ── autoApprove ──────────────────────────────────────────────
  const autoApproveRef = useRef(autoApprove);
  useEffect(() => { autoApproveRef.current = autoApprove; }, [autoApprove]);
  useEffect(() => {
    if (!approval || !autoApproveRef.current) return;
    setInspector((prev) => ({ ...prev, approval_received: true }));
    pipelineRunner.approve(userId.trim());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approval]);

  // ── 단일 실행 ────────────────────────────────────────────────
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

    resetRun();
    setEvents([]);
    setStreamingBody("");

    const selectedTitle = topicMode === "list"
      ? topics.find((t) => t.topicId === selectedTopicId)?.title ?? selectedTopicId
      : directTitle.trim();

    setInspector({
      ...usePipelineStore.getState().inspector,
      selected_topic: selectedTitle,
      remaining_topics_count: availableTopics.length,
    });

    const topicId = await resolveTopicId();
    if (!topicId) return;
    pipelineRunner.start(topicId, uid, selectedTitle);
  };

  const handleApprove = async (req: ApprovalRequest) => {
    if (!req.approved) { pipelineRunner.reject(); return; }
    setInspector((prev) => ({ ...prev, approval_received: true }));
    pipelineRunner.approve(userId.trim());
  };

  const handleRecoverStuck = async () => {
    setRecovering(true);
    try {
      const res = await fetch("/api/github/topics/recover-stuck", { method: "POST" });
      if (res.ok) reloadTopics();
    } finally { setRecovering(false); }
  };

  // ── 배치 실행 ────────────────────────────────────────────────
  const startBatch = async () => {
    const uid = userId.trim();
    if (!uid || batchSelected.size === 0 || batchRunning) return;
    const queue: BatchItemStatus[] = [...batchSelected].map((id) => ({
      topicId: id,
      title: availableTopics.find((t) => t.topicId === id)?.title ?? id,
      status: "pending",
    }));
    setBatchQueue(queue);
    setBatchRunning(true);
    await pipelineRunner.startBatch(queue, uid, (idx, update) =>
      setBatchQueue((prev) => prev.map((item, i) => (i === idx ? { ...item, ...update } : item)))
    );
    setBatchRunning(false);
    reloadTopics();
  };

  const toggleBatchItem = (topicId: string) => {
    setBatchSelected((prev) => {
      const next = new Set(prev);
      if (next.has(topicId)) next.delete(topicId); else next.add(topicId);
      return next;
    });
  };

  // ── 파생 상태 ─────────────────────────────────────────────────
  const currentUid = userId.trim().toLowerCase();
  const userTopics = currentUid
    ? topics.filter((t) => t.assignedUserId?.toLowerCase() === currentUid)
    : topics;
  const { remaining: availableTopics } = resolveRemainingTopics(userTopics, posts);

  const canStart = !running && !!userId.trim() &&
    (topicMode === "list" ? !!selectedTopicId : !!directTitle.trim());
  const canStartBatch = !!userId.trim() && batchSelected.size > 0 && !batchRunning && !running;

  const batchDone = batchQueue.filter((q) => q.status === "done" || q.status === "failed").length;
  const batchTotal = batchQueue.length;

  const progressEvents = events.filter(
    (e: SSEEvent) => e.type === "stage_change" || e.type === "progress" || e.type === "error"
  );

  const hasRightContent = !!(streamingBody || result);

  // ─────────────────────────────────────────────────────────────
  return (
    // 2컬럼 레이아웃: 좌(설정/컨트롤) + 우(본문)
    <div className="flex min-h-full">

      {/* ══ 왼쪽 패널 — 설정 및 실행 제어 ══════════════════════ */}
      <div className={`shrink-0 overflow-y-auto p-6 space-y-4 border-r border-zinc-100 ${hasRightContent ? "w-[420px]" : "w-full max-w-2xl"}`}>

        <div>
          <h1 className="text-xl font-bold text-zinc-900">글쓰기 실행</h1>
          <p className="text-zinc-500 mt-0.5 text-sm">승인 후 본문 작성 시작</p>
        </div>

        {/* stuck 복구 */}
        {stuckCount > 0 && (
          <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
            <p className="text-sm text-amber-800">
              <span className="font-semibold">{stuckCount}개 토픽</span>이 멈춰 있습니다.
            </p>
            <button onClick={handleRecoverStuck} disabled={recovering}
              className="ml-4 px-3 py-1 bg-amber-600 text-white text-xs font-semibold rounded hover:bg-amber-700 disabled:opacity-50 transition-colors whitespace-nowrap">
              {recovering ? "복구 중..." : "일괄 복구"}
            </button>
          </div>
        )}

        {/* 에러 배너 */}
        {pipelineError && (
          <div className="flex items-start justify-between bg-red-50 border border-red-200 rounded-lg px-4 py-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-red-700">글쓰기 실패</p>
              <p className="text-xs text-red-600 mt-0.5 break-words">{pipelineError}</p>
            </div>
            <button onClick={() => setPipelineError(null)} className="ml-3 text-red-400 hover:text-red-600 shrink-0 text-lg leading-none">×</button>
          </div>
        )}

        {/* 설정 카드 */}
        <div className="bg-white border border-zinc-200 rounded-xl p-4 space-y-4">

          {/* 실행 모드 탭 */}
          <div className="flex gap-2">
            {(["single", "batch"] as const).map((mode) => (
              <button key={mode} onClick={() => setExecMode(mode)} disabled={running || batchRunning}
                className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors disabled:opacity-50 ${execMode === mode ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"}`}>
                {mode === "single" ? "단일 실행" : "배치 실행"}
              </button>
            ))}
          </div>

          {/* 사용자 */}
          <div>
            <label className="block text-xs font-semibold text-zinc-600 mb-1">사용자</label>
            <div className="flex items-center gap-2">
              <input value={userId} onChange={(e) => setUserId(e.target.value)}
                placeholder="사용자 ID" disabled={running || batchRunning}
                className="flex-1 border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50" />
              {profileLoading && <span className="text-xs text-zinc-400">확인 중...</span>}
              {!profileLoading && profile && <span className="text-xs text-emerald-600 font-medium shrink-0">{profile.displayName}</span>}
              {!profileLoading && userId.trim() && !profile && profileError && <span className="text-xs text-red-500 shrink-0">오류</span>}
            </div>
            {profile?.naverBlogUrl && (
              <a href={profile.naverBlogUrl} target="_blank" rel="noopener noreferrer"
                className="text-xs text-blue-500 hover:underline truncate block mt-1">
                {profile.naverBlogUrl}
              </a>
            )}
          </div>

          {/* ── 단일 실행 ── */}
          {execMode === "single" && (
            <>
              <div>
                <label className="block text-xs font-semibold text-zinc-600 mb-2">주제 선택</label>
                <div className="flex gap-2 mb-2">
                  {(["list", "direct"] as const).map((mode) => (
                    <button key={mode} onClick={() => setTopicMode(mode)} disabled={running}
                      className={`px-3 py-1 text-xs font-medium rounded-full transition-colors disabled:opacity-50 ${topicMode === mode ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"}`}>
                      {mode === "list" ? "글목록" : "직접 입력"}
                    </button>
                  ))}
                </div>
                {topicMode === "list" ? (
                  <select value={selectedTopicId} onChange={(e) => setSelectedTopicId(e.target.value)}
                    disabled={running}
                    className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50">
                    <option value="">주제를 선택하세요</option>
                    {availableTopics.map((t) => (
                      <option key={t.topicId} value={t.topicId}>{t.title}</option>
                    ))}
                  </select>
                ) : (
                  <input value={directTitle} onChange={(e) => setDirectTitle(e.target.value)}
                    placeholder="예: 서울 카페 베스트 10"
                    disabled={running}
                    className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50" />
                )}
              </div>

              <label className="flex items-center gap-2 text-xs text-zinc-500 cursor-pointer select-none">
                <input type="checkbox" checked={autoApprove}
                  onChange={(e) => setAutoApprove(e.target.checked)} disabled={running} className="rounded" />
                <span>자동 승인 모드</span>
              </label>

              <button onClick={startPipeline} disabled={!canStart}
                className="w-full py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                {running ? "글쓰기 진행 중..." : "글쓰기 시작"}
              </button>
            </>
          )}

          {/* ── 배치 실행 ── */}
          {execMode === "batch" && (
            <>
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs font-semibold text-zinc-600">
                    주제 선택 {batchSelected.size > 0 && <span className="text-blue-600 ml-1">{batchSelected.size}개</span>}
                  </label>
                  <div className="flex gap-2 text-xs text-zinc-500">
                    <button onClick={() => setBatchSelected(new Set(availableTopics.map((t) => t.topicId)))}
                      disabled={batchRunning} className="hover:text-zinc-800 disabled:opacity-40">전체</button>
                    <span className="text-zinc-300">|</span>
                    <button onClick={() => setBatchSelected(new Set())}
                      disabled={batchRunning} className="hover:text-zinc-800 disabled:opacity-40">해제</button>
                  </div>
                </div>
                <div className="border border-zinc-200 rounded-lg divide-y divide-zinc-100 max-h-52 overflow-y-auto">
                  {availableTopics.length === 0
                    ? <p className="text-xs text-zinc-400 px-3 py-2">배정된 주제가 없습니다.</p>
                    : availableTopics.map((t) => (
                      <label key={t.topicId}
                        className={`flex items-center gap-3 px-3 py-2 cursor-pointer select-none transition-colors ${batchSelected.has(t.topicId) ? "bg-blue-50" : "hover:bg-zinc-50"} ${batchRunning ? "opacity-50 pointer-events-none" : ""}`}>
                        <input type="checkbox" checked={batchSelected.has(t.topicId)}
                          onChange={() => toggleBatchItem(t.topicId)} disabled={batchRunning} className="rounded shrink-0" />
                        <span className="text-xs text-zinc-800 truncate">{t.title}</span>
                      </label>
                    ))}
                </div>
              </div>

              <div className="flex gap-2">
                <button onClick={startBatch} disabled={!canStartBatch}
                  className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
                  {batchRunning ? `배치 실행 중... (${batchDone}/${batchTotal})` : `배치 실행 (${batchSelected.size}개)`}
                </button>
                {batchRunning && (
                  <button onClick={() => pipelineRunner.stopBatch()}
                    className="px-3 py-2.5 bg-zinc-200 text-zinc-700 text-sm font-semibold rounded-lg hover:bg-zinc-300">
                    중단
                  </button>
                )}
              </div>
            </>
          )}
        </div>

        {/* 타이머 */}
        {running && (
          <div className={`rounded-xl p-3 flex items-center justify-between ${elapsed > 240 ? "bg-red-50 border border-red-200" : "bg-blue-50 border border-blue-200"}`}>
            <div className="flex items-center gap-2 min-w-0">
              <span className="animate-pulse">⏱</span>
              <span className={`text-sm font-medium truncate ${elapsed > 240 ? "text-red-700" : "text-blue-700"}`}>
                {runningTitle ?? "글쓰기 진행 중..."}
              </span>
            </div>
            <span className={`text-lg font-mono font-bold shrink-0 ml-3 ${elapsed > 240 ? "text-red-600" : "text-blue-600"}`}>
              {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}
            </span>
          </div>
        )}

        {/* 단계 표시 */}
        {execMode === "single" && stage !== "idle" && (
          <div className="bg-white border border-zinc-200 rounded-xl p-4 overflow-x-auto">
            <StageIndicator currentStage={stage} />
          </div>
        )}

        {/* 파이프라인 인스펙터 */}
        {execMode === "single" && (
          <PipelineStateInspector state={inspector} />
        )}

        {/* 이벤트 로그 */}
        {execMode === "single" && events.length > 0 && (
          <div ref={logRef} className="bg-zinc-950 rounded-lg p-3 h-36 overflow-y-auto font-mono text-xs">
            {progressEvents.map((e: SSEEvent, i: number) => {
              const data = e.data as Record<string, unknown>;
              const msg = (data?.message as string) ?? e.type;
              const color = e.type === "error" ? "text-red-400" : e.type === "stage_change" ? "text-blue-400" : "text-zinc-400";
              return (
                <p key={i} className={color}>
                  <span className="text-zinc-600">{new Date(e.timestamp).toLocaleTimeString("ko-KR")}</span>{" "}{msg}
                </p>
              );
            })}
          </div>
        )}

        {/* 배치 진행 현황 */}
        {execMode === "batch" && batchQueue.length > 0 && (
          <div className="bg-white border border-zinc-200 rounded-xl p-4">
            <div className="flex items-center justify-between mb-2">
              <p className="text-sm font-semibold text-zinc-700">배치 진행</p>
              <span className="text-xs text-zinc-500 font-mono">{batchDone}/{batchTotal}</span>
            </div>
            <div className="w-full bg-zinc-100 rounded-full h-1.5 mb-3">
              <div className="bg-blue-500 h-1.5 rounded-full transition-all duration-500"
                style={{ width: batchTotal > 0 ? `${(batchDone / batchTotal) * 100}%` : "0%" }} />
            </div>
            <div className="space-y-1.5 max-h-64 overflow-y-auto">
              {batchQueue.map((item, idx) => (
                <div key={item.topicId}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${item.status === "running" ? "bg-blue-50 border border-blue-200" : item.status === "done" ? "bg-emerald-50 border border-emerald-100" : item.status === "failed" ? "bg-red-50 border border-red-100" : "bg-zinc-50 border border-zinc-100"}`}>
                  <span className="shrink-0 w-4 text-center">
                    {item.status === "pending" && <span className="text-zinc-400">{idx + 1}</span>}
                    {item.status === "running" && <span className="animate-spin inline-block text-blue-500">⟳</span>}
                    {item.status === "done" && item.pass !== false && <span className="text-emerald-500">✓</span>}
                    {item.status === "done" && item.pass === false && <span className="text-amber-500">△</span>}
                    {item.status === "failed" && <span className="text-red-400">✗</span>}
                  </span>
                  <span className={`flex-1 truncate ${item.status === "pending" ? "text-zinc-400" : "text-zinc-800"}`}>{item.title}</span>
                  {item.status === "done" && item.evalScore != null && (
                    <span className="shrink-0 text-zinc-500 font-mono">{item.evalScore}점</span>
                  )}
                  {item.status === "running" && <span className="shrink-0 text-blue-500">처리 중...</span>}
                </div>
              ))}
            </div>
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
      </div>

      {/* ══ 오른쪽 패널 — 본문 ══════════════════════════════════ */}
      <div className="flex-1 flex flex-col sticky top-0 h-screen border-l border-zinc-100">

        {/* 헤더 바 */}
        <div className="shrink-0 px-6 py-3 border-b border-zinc-100 bg-white flex items-center gap-3">
          {streamingBody && !result && (
            <>
              <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse shrink-0" />
              <span className="text-sm font-medium text-zinc-700">본문 생성 중...</span>
              <span className="text-xs text-zinc-400 ml-auto">{streamingBody.length.toLocaleString()}자</span>
            </>
          )}
          {result && (
            <>
              <span className={`w-2 h-2 rounded-full shrink-0 ${result.pass ? "bg-emerald-500" : "bg-amber-500"}`} />
              <span className="text-sm font-medium text-zinc-700">{result.title}</span>
              <span className="text-xs text-zinc-500 ml-auto font-mono">
                {result.wordCount.toLocaleString()}자 · {result.evalScore}점
                {result.pass ? " ✓" : " ⚠"}
              </span>
            </>
          )}
          {!streamingBody && !result && (
            <span className="text-sm text-zinc-400">본문이 여기에 표시됩니다</span>
          )}
        </div>

        {/* 본문 영역 */}
        <div ref={bodyRef} className="flex-1 overflow-y-auto">
          {streamingBody ? (
            <pre className="p-6 text-sm text-zinc-100 whitespace-pre-wrap font-sans leading-relaxed bg-zinc-950 min-h-full">
              {streamingBody}
            </pre>
          ) : result ? (
            <div className="p-6 space-y-4">
              {/* 결과 상태 카드 */}
              <div className={`border rounded-xl p-4 ${result.pass ? "bg-emerald-50 border-emerald-200" : "bg-amber-50 border-amber-200"}`}>
                <p className={`font-semibold text-sm ${result.pass ? "text-emerald-700" : "text-amber-700"}`}>
                  {result.pass ? "✓ 글쓰기 완료" : "⚠ 완료 — 평가 점수 미달"}
                </p>
                <p className="text-zinc-800 font-medium mt-1">{result.title}</p>
                <p className="text-xs text-zinc-500 mt-0.5">{result.wordCount.toLocaleString()}자 · 평가 점수 {result.evalScore}점</p>
              </div>
              {result.recommendations.length > 0 && (
                <div className="bg-white border border-zinc-200 rounded-xl p-4">
                  <p className="text-xs font-semibold text-zinc-600 mb-2">개선 권고사항</p>
                  <ul className="space-y-1">
                    {result.recommendations.map((r, i) => (
                      <li key={i} className="text-sm text-zinc-700 flex gap-2">
                        <span className="text-zinc-400 shrink-0">•</span> {r}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-zinc-300">
              <div className="text-center">
                <p className="text-4xl mb-3">▶</p>
                <p className="text-sm">글쓰기를 시작하면</p>
                <p className="text-sm">본문이 실시간으로 표시됩니다</p>
              </div>
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
