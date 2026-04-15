"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { StageIndicator } from "@/components/pipeline/stage-indicator";
import { PipelineStream } from "@/components/pipeline/pipeline-stream";
import { ApprovalDialog } from "@/components/pipeline/approval-dialog";
import { PipelineStateInspector } from "@/components/pipeline/state-inspector";
import { usePipelineStore } from "@/lib/store/pipeline-store";
import { pipelineRunner } from "@/lib/pipeline-runner";
import type { BatchItemStatus } from "@/lib/pipeline-runner";
import type { ApprovalRequest } from "@/lib/agents/types";
import type { Topic, UserProfile, PostingRecord } from "@/lib/types/github-data";
import { resolveRemainingTopics } from "@/lib/skills/remaining-topic-resolver";

export default function PipelinePage() {
  // ── Zustand store — 네비게이션 후에도 상태 유지 ───────────────
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
  const running = usePipelineStore((s) => s.running);        // 스토어에서 읽음
  const approval = usePipelineStore((s) => s.approval);      // 스토어에서 읽음
  const pipelineError = usePipelineStore((s) => s.pipelineError); // 스토어에서 읽음

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

  // ── 로컬 상태 — 시각적 보조 (리마운트 시 초기화 허용) ────────
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [topics, setTopics] = useState<Topic[]>([]);
  const [posts, setPosts] = useState<PostingRecord[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [stuckCount, setStuckCount] = useState(0);
  const [recovering, setRecovering] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── 배치 실행 상태 ────────────────────────────────────────────
  const [execMode, setExecMode] = useState<"single" | "batch">("single");
  const [batchSelected, setBatchSelected] = useState<Set<string>>(new Set());
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchQueue, setBatchQueue] = useState<BatchItemStatus[]>([]);

  // ── 타이머: running이 true면 시작, false면 정지 ──────────────
  // running은 이제 Zustand에 있으므로 컴포넌트 리마운트 시에도
  // 이미 실행 중이라면 타이머가 자동으로 재시작됨
  useEffect(() => {
    if (running) {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000);
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    }
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  }, [running]);

  // ── 토픽/포스트 목록 로드 ────────────────────────────────────
  const reloadTopics = useCallback(() => {
    const t = Date.now();
    Promise.allSettled([
      fetch(`/api/github/topics?_t=${t}`).then((r) => r.json()) as Promise<{ topics: Topic[] }>,
      fetch(`/api/github/posts?limit=1000&_t=${t}`).then((r) => r.json()) as Promise<{ posts: PostingRecord[] }>,
      fetch(`/api/github/topics/recover-stuck?_t=${t}`).then((r) => r.json()) as Promise<{ count: number }>,
    ]).then(([topicResult, postResult, stuckResult]) => {
      const postData = postResult.status === "fulfilled" ? postResult.value : { posts: [] };
      const topicData = topicResult.status === "fulfilled" ? topicResult.value : { topics: [] };
      const stuckData = stuckResult.status === "fulfilled" ? stuckResult.value : { count: 0 };
      setTopics((topicData.topics ?? []).filter((t) => t.status === "draft"));
      setPosts(postData.posts ?? []);
      setStuckCount(stuckData.count ?? 0);
    });
  }, []);

  useEffect(() => { reloadTopics(); }, [reloadTopics]);

  // ── 사용자 프로필 로드 ────────────────────────────────────────
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

  // ── autoApprove: approval이 생기면 즉시 approve ──────────────
  const autoApproveRef = useRef(autoApprove);
  useEffect(() => { autoApproveRef.current = autoApprove; }, [autoApprove]);

  useEffect(() => {
    if (!approval || !autoApproveRef.current) return;
    setInspector((prev) => ({ ...prev, approval_received: true }));
    pipelineRunner.approve(userId.trim());
  // approval이 세팅될 때만 실행
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [approval]);

  // ── 직접 주제 입력: draft 토픽 생성 후 ID 반환 ───────────────
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

  // ── 단일 실행 시작 ────────────────────────────────────────────
  const startPipeline = async () => {
    const uid = userId.trim();
    if (!uid) return;
    if (topicMode === "list" && !selectedTopicId) return;
    if (topicMode === "direct" && !directTitle.trim()) return;

    resetRun();
    setEvents([]);
    setStreamingBody("");

    const selectedTitle =
      topicMode === "list"
        ? topics.find((t) => t.topicId === selectedTopicId)?.title ?? selectedTopicId
        : directTitle.trim();

    setInspector({
      ...usePipelineStore.getState().inspector,
      selected_topic: selectedTitle,
      remaining_topics_count: availableTopics.length,
    });

    const topicId = await resolveTopicId();
    if (!topicId) return;

    // PipelineRunner가 SSE 루프를 독립적으로 관리
    // 컴포넌트가 언마운트되어도 실행은 계속됨
    pipelineRunner.start(topicId, uid, selectedTitle);
  };

  // ── 승인/거절 처리 ────────────────────────────────────────────
  const handleApprove = async (req: ApprovalRequest) => {
    if (!req.approved) {
      pipelineRunner.reject();
      return;
    }
    setInspector((prev) => ({ ...prev, approval_received: true }));
    pipelineRunner.approve(userId.trim());
  };

  // ── stuck 복구 ────────────────────────────────────────────────
  const handleRecoverStuck = async () => {
    setRecovering(true);
    try {
      const res = await fetch("/api/github/topics/recover-stuck", { method: "POST" });
      if (res.ok) { reloadTopics(); }
    } finally {
      setRecovering(false);
    }
  };

  // ── 배치 실행 ─────────────────────────────────────────────────
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

    await pipelineRunner.startBatch(queue, uid, (idx, update) => {
      setBatchQueue((prev) =>
        prev.map((item, i) => (i === idx ? { ...item, ...update } : item))
      );
    });

    setBatchRunning(false);
    reloadTopics();
  };

  const stopBatch = () => { pipelineRunner.stopBatch(); };

  const toggleBatchItem = (topicId: string) => {
    setBatchSelected((prev) => {
      const next = new Set(prev);
      if (next.has(topicId)) next.delete(topicId); else next.add(topicId);
      return next;
    });
  };
  const selectAllBatch = () => setBatchSelected(new Set(availableTopics.map((t) => t.topicId)));
  const clearBatchSelection = () => setBatchSelected(new Set());

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

  // ─────────────────────────────────────────────────────────────
  return (
    <div className="p-8 max-w-3xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900">글쓰기 실행</h1>
        <p className="text-zinc-500 mt-1 text-sm">승인 후 본문 작성 시작</p>
      </div>

      {/* ── stuck 복구 경고 ──────────────────────────────────── */}
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

      {/* ── 파이프라인 에러 배너 ─────────────────────────────── */}
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

      {/* ── 실행 설정 카드 ───────────────────────────────────── */}
      <div className="bg-white border border-zinc-200 rounded-xl p-5 mb-6 space-y-5">

        {/* 실행 모드 탭 */}
        <div>
          <label className="block text-xs font-semibold text-zinc-600 mb-2">실행 모드</label>
          <div className="flex gap-2">
            {(["single", "batch"] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setExecMode(mode)}
                disabled={running || batchRunning}
                className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors disabled:opacity-50 ${
                  execMode === mode
                    ? "bg-zinc-900 text-white"
                    : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                }`}
              >
                {mode === "single" ? "단일 실행" : "배치 실행"}
              </button>
            ))}
          </div>
        </div>

        {/* 사용자 선택 */}
        <div>
          <label className="block text-xs font-semibold text-zinc-600 mb-1">사용자 선택</label>
          <div className="flex items-center gap-3">
            <input
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              placeholder="사용자 ID 입력"
              disabled={running || batchRunning}
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

        {/* 블로그 정보 */}
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

        {/* ── 단일 실행 컨트롤 ──────────────────────────────── */}
        {execMode === "single" && (
          <>
            <div>
              <label className="block text-xs font-semibold text-zinc-600 mb-2">주제 선택 방식</label>
              <div className="flex gap-2 mb-3">
                {(["list", "direct"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setTopicMode(mode)}
                    disabled={running}
                    className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors disabled:opacity-50 ${
                      topicMode === mode
                        ? "bg-zinc-900 text-white"
                        : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
                    }`}
                  >
                    {mode === "list" ? "글목록에서 선택" : "직접 주제 입력"}
                  </button>
                ))}
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

            <label className="flex items-center gap-2 text-xs text-zinc-500 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoApprove}
                onChange={(e) => setAutoApprove(e.target.checked)}
                disabled={running}
                className="rounded"
              />
              <span>자동 승인 모드 <span className="text-zinc-400">(전략 검토 없이 즉시 진행)</span></span>
            </label>

            <button
              onClick={startPipeline}
              disabled={!canStart}
              className="w-full py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {running ? "글쓰기 진행 중..." : "글쓰기 시작"}
            </button>
          </>
        )}

        {/* ── 배치 실행 컨트롤 ──────────────────────────────── */}
        {execMode === "batch" && (
          <>
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs font-semibold text-zinc-600">
                  주제 선택
                  {batchSelected.size > 0 && (
                    <span className="ml-2 text-blue-600">{batchSelected.size}개 선택됨</span>
                  )}
                </label>
                <div className="flex gap-2">
                  <button
                    onClick={selectAllBatch}
                    disabled={batchRunning || availableTopics.length === 0}
                    className="text-xs text-zinc-500 hover:text-zinc-800 disabled:opacity-40 transition-colors"
                  >
                    전체 선택
                  </button>
                  <span className="text-zinc-300">|</span>
                  <button
                    onClick={clearBatchSelection}
                    disabled={batchRunning || batchSelected.size === 0}
                    className="text-xs text-zinc-500 hover:text-zinc-800 disabled:opacity-40 transition-colors"
                  >
                    선택 해제
                  </button>
                </div>
              </div>

              {availableTopics.length === 0 ? (
                <p className="text-xs text-zinc-400 py-2">
                  {userId.trim()
                    ? `'${userId.trim()}' 사용자에게 배정된 주제가 없습니다.`
                    : <>글목록이 비어 있습니다. <a href="/topics" className="text-blue-500 hover:underline">글목록</a>에서 먼저 등록해 주세요.</>
                  }
                </p>
              ) : (
                <div className="border border-zinc-200 rounded-lg divide-y divide-zinc-100 max-h-56 overflow-y-auto">
                  {availableTopics.map((t) => (
                    <label
                      key={t.topicId}
                      className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer select-none transition-colors ${
                        batchSelected.has(t.topicId) ? "bg-blue-50" : "hover:bg-zinc-50"
                      } ${batchRunning ? "opacity-50 pointer-events-none" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={batchSelected.has(t.topicId)}
                        onChange={() => toggleBatchItem(t.topicId)}
                        disabled={batchRunning}
                        className="rounded shrink-0"
                      />
                      <span className="text-sm text-zinc-800 truncate">{t.title}</span>
                    </label>
                  ))}
                </div>
              )}
              <p className="text-xs text-zinc-400 mt-1.5">배치 실행은 자동 승인 모드로 순차 처리됩니다.</p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={startBatch}
                disabled={!canStartBatch}
                className="flex-1 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {batchRunning
                  ? `배치 실행 중... (${batchDone}/${batchTotal})`
                  : `배치 실행 (${batchSelected.size}개)`}
              </button>
              {batchRunning && (
                <button
                  onClick={stopBatch}
                  className="px-4 py-2.5 bg-zinc-200 text-zinc-700 text-sm font-semibold rounded-lg hover:bg-zinc-300 transition-colors"
                >
                  중단
                </button>
              )}
            </div>
          </>
        )}

      </div>

      {/* ── 배치 진행 현황 ──────────────────────────────────── */}
      {execMode === "batch" && batchQueue.length > 0 && (
        <div className="bg-white border border-zinc-200 rounded-xl p-5 mb-6">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-zinc-700">배치 진행 현황</p>
            <span className="text-xs text-zinc-500 font-mono">{batchDone} / {batchTotal}</span>
          </div>
          <div className="w-full bg-zinc-100 rounded-full h-1.5 mb-4">
            <div
              className="bg-blue-500 h-1.5 rounded-full transition-all duration-500"
              style={{ width: batchTotal > 0 ? `${(batchDone / batchTotal) * 100}%` : "0%" }}
            />
          </div>
          <div className="space-y-2">
            {batchQueue.map((item, idx) => (
              <div
                key={item.topicId}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm ${
                  item.status === "running"
                    ? "bg-blue-50 border border-blue-200"
                    : item.status === "done"
                    ? "bg-emerald-50 border border-emerald-100"
                    : item.status === "failed"
                    ? "bg-red-50 border border-red-100"
                    : "bg-zinc-50 border border-zinc-100"
                }`}
              >
                <span className="shrink-0 w-5 text-center">
                  {item.status === "pending" && <span className="text-zinc-400 text-xs font-mono">{idx + 1}</span>}
                  {item.status === "running" && <span className="animate-spin inline-block text-blue-500">⟳</span>}
                  {item.status === "done" && item.pass !== false && <span className="text-emerald-500">✓</span>}
                  {item.status === "done" && item.pass === false && <span className="text-amber-500">△</span>}
                  {item.status === "failed" && <span className="text-red-400">✗</span>}
                </span>
                <span className={`flex-1 truncate ${item.status === "pending" ? "text-zinc-400" : "text-zinc-800"}`}>
                  {item.title}
                </span>
                {item.status === "done" && (
                  <span className="shrink-0 text-xs text-zinc-500 font-mono">
                    {item.evalScore != null ? `${item.evalScore}점` : ""}
                    {item.wordCount != null ? ` · ${item.wordCount.toLocaleString()}자` : ""}
                  </span>
                )}
                {item.status === "failed" && <span className="shrink-0 text-xs text-red-400">실패</span>}
                {item.status === "running" && <span className="shrink-0 text-xs text-blue-500">처리 중...</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── 단일 실행 — 타이머 ──────────────────────────────── */}
      {execMode === "single" && running && (
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

      {/* ── 단일 실행 — 단계 표시 ───────────────────────────── */}
      {execMode === "single" && stage !== "idle" && (
        <div className="bg-white border border-zinc-200 rounded-xl p-5 mb-6 overflow-x-auto">
          <StageIndicator currentStage={stage} />
        </div>
      )}

      {/* ── 단일 실행 — 파이프라인 인스펙터 ────────────────── */}
      {execMode === "single" && (
        <div className="mb-6">
          <PipelineStateInspector state={inspector} />
        </div>
      )}

      {/* ── 단일 실행 — 스트리밍 로그 ───────────────────────── */}
      {execMode === "single" && (events.length > 0 || streamingBody) && (
        <div className="mb-6">
          <PipelineStream events={events} streamingBody={streamingBody} />
        </div>
      )}

      {/* ── 승인 다이얼로그 — 실행 모드 무관하게 표시 ─────── */}
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

      {/* ── 단일 실행 — 결과 ─────────────────────────────────── */}
      {execMode === "single" && result && (
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
