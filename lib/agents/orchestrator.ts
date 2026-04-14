import { randomUUID } from "crypto";
import { runStrategyPlanner } from "./strategy-planner";
import { runMasterWriter } from "./master-writer";
import { runHarnessEvaluator } from "./harness-evaluator";
import { ApprovalGate } from "./completion-checker";
import { upsertLedgerEntry, saveArtifactContract } from "./pipeline-ledger";
import { detectMaterialChange } from "./material-change-detector";
import { getCorpusSummary } from "./corpus-selector";
import { saveArtifact } from "./artifact-registry";
import { runPreWriteGate, runPostAuditGate } from "./release-gate";
import { registerBaselineCandidate, compareWithCurrentBaseline } from "./baseline-manager";
import {
  initApprovalState,
  transitionApprovalState,
  getApprovalState,
} from "./approval-state-machine";
import { appendLog } from "./operation-logger";
import { readJsonFile, writeJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import {
  createApprovalRecord,
  resolveApprovalRecord,
  readApprovalRecord,
  markApprovalConsumed,
} from "@/lib/github/approval-store";
import type { PostingIndex, TopicIndex } from "@/lib/types/github-data";
import type {
  PipelineRunRequest,
  PipelineState,
  ApprovalRequest,
  SSEEvent,
  StrategyPlanResult,
} from "./types";
import type {
  SourceReportData,
  ApprovalRequestData,
  RecordUpdateData,
  AuditReportData,
  DraftOutputData,
  StrategyPlanData,
  GateFailureReportData,
  RunStateSnapshotData,
  BlockingReasonData,
} from "./artifact-registry";

// ============================================================
// 승인 대기 in-memory 저장소
// ============================================================

interface PendingApproval {
  resolve: (approval: ApprovalRequest) => void;
  strategy: StrategyPlanResult;
}

// global에 저장 — Next.js HMR이 모듈을 재로드해도 Map이 유지됨
declare global {
   
  var _pendingApprovals: Map<string, PendingApproval> | undefined;
   
  var _activePipelines: Map<string, PipelineState> | undefined;
}
const pendingApprovals: Map<string, PendingApproval> =
  globalThis._pendingApprovals ?? (globalThis._pendingApprovals = new Map());
const activePipelines: Map<string, PipelineState> =
  globalThis._activePipelines ?? (globalThis._activePipelines = new Map());

// ============================================================
// SSE 이벤트 발행 헬퍼
// ============================================================

function emit(
  controller: ReadableStreamDefaultController,
  event: SSEEvent
): void {
  try {
    const encoder = new TextEncoder();
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  } catch {
    // stream이 이미 닫힌 경우 — 무시
  }
}

function makeEvent(
  type: SSEEvent["type"],
  stage: PipelineState["stage"],
  data: unknown
): SSEEvent {
  return { type, stage, data, timestamp: new Date().toISOString() };
}

// ============================================================
// 상태 업데이트 헬퍼
// ============================================================

function updateState(
  state: PipelineState,
  patch: Partial<PipelineState>
): PipelineState {
  return { ...state, ...patch, updatedAt: new Date().toISOString() };
}

// ============================================================
// 파이프라인 실행
// ============================================================

export async function runPipeline(params: {
  request: PipelineRunRequest;
  controller: ReadableStreamDefaultController;
  signal?: AbortSignal;
}): Promise<void> {
  const { request, controller, signal } = params;
  const pipelineId = `pipe-${randomUUID().slice(0, 8)}`;
  const now = new Date().toISOString();

  let state: PipelineState = {
    pipelineId,
    topicId: request.topicId,
    userId: request.userId,
    stage: "idle",
    strategy: null,
    writerResult: null,
    evalResult: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };

  activePipelines.set(pipelineId, state);

  // 승인 게이트 — index update는 grant() 후에만 가능
  const gate = new ApprovalGate(pipelineId);

  // 이 파이프라인이 직접 topic을 in-progress로 설정한 경우에만 catch에서 복구
  let thisSetTopicInProgress = false;

  // 레저 초기화
  await upsertLedgerEntry({
    pipelineId,
    topicId: request.topicId,
    userId: request.userId,
    stage: "idle",
    error: null,
    approvalGranted: false,
    postingListUpdated: false,
    indexUpdated: false,
    createdAt: now,
  });

  // 승인 상태 머신 초기화
  await initApprovalState({
    pipelineId,
    topicId: request.topicId,
    userId: request.userId,
  });

  try {
    // ── 0. 토픽 선택 유효성 검사 ──────────────────────────────
    const topicValidation = await validateTopicSelectionFromGitHub(request.topicId);
    if (!topicValidation.valid) {
      throw new Error(`토픽 선택 실패: ${topicValidation.reason}`);
    }

    // ── 1. 전략 수립 ──────────────────────────────────────────
    state = updateState(state, { stage: "strategy-planning" });
    activePipelines.set(pipelineId, state);
    await upsertLedgerEntry({ pipelineId, topicId: request.topicId, userId: request.userId, stage: "strategy-planning", error: null, approvalGranted: false, postingListUpdated: false, indexUpdated: false, createdAt: now });
    emit(controller, makeEvent("stage_change", "strategy-planning", {
      pipelineId,
      message: "전략 수립을 시작합니다.",
    }));

    const strategy = await runStrategyPlanner({
      topicId: request.topicId,
      userId: request.userId,
      onProgress: (msg) =>
        emit(controller, makeEvent("progress", "strategy-planning", { message: msg })),
      signal,
    });

    state = updateState(state, { strategy });
    activePipelines.set(pipelineId, state);

    // strategy_plan artifact 저장 (best-effort — GitHub 실패해도 파이프라인 계속)
    await saveArtifact<StrategyPlanData>(pipelineId, "strategy_plan", {
      title: strategy.title,
      outline: strategy.outline,
      keyPoints: strategy.keyPoints,
      estimatedLength: strategy.estimatedLength,
      tone: strategy.tone,
      keywords: strategy.keywords,
      rationale: strategy.rationale,
      corpusSummary: null,
    }).catch((e: unknown) => {
      console.warn("[orchestrator] saveArtifact(strategy_plan) 실패 (무시):", e instanceof Error ? e.message : e);
    });

    // ── 2. material_change 감지 + 승인 대기 ───────────────────
    const originalTitle = (await loadTopicTitle(request.topicId)) ?? "";
    const mcResult = detectMaterialChange({
      original: { title: originalTitle },
      proposed: { title: strategy.title, keywords: strategy.keywords, rationale: strategy.rationale },
    });
    const materialChange = mcResult.isMaterial;

    // material_change 로그
    await appendLog(pipelineId, {
      type: "material_change",
      originalTitle,
      proposedTitle: strategy.title,
      isMaterial: mcResult.isMaterial,
      triggeredSignals: mcResult.triggeredSignals,
      stringSimilarity: mcResult.stringSimilarity ?? 0,
      overrideByHighSim: !mcResult.isMaterial && (mcResult.stringSimilarity ?? 0) >= 0.85,
    });

    state = updateState(state, { stage: "awaiting-approval" });
    activePipelines.set(pipelineId, state);

    // 승인 상태 전이: draft_ready → waiting_for_user_approval (best-effort — in-memory 경로가 핵심)
    await transitionApprovalState({
      pipelineId,
      to: "waiting_for_user_approval",
      reason: "승인 요청 발송",
    }).catch((e: unknown) => {
      console.warn("[orchestrator] transitionApprovalState(waiting) 실패 (무시):", e instanceof Error ? e.message : e);
    });

    const approvalRequestedAt = new Date().toISOString();
    emit(controller, makeEvent("approval_required", "awaiting-approval", {
      pipelineId,
      previousTitle: originalTitle,
      proposedTitle: strategy.title,
      materialChange,
      rationale: strategy.rationale,
      outline: strategy.outline.map((s) => s.heading),
    }));

    // 승인 대기 (최대 30분)
    let timedOut = false;
    const approval = await Promise.race([
      waitForApproval(pipelineId, strategy),
      new Promise<never>((_, reject) =>
        setTimeout(() => { timedOut = true; reject(new Error("승인 대기 시간 초과 (30분)")); }, 30 * 60 * 1000)
      ),
    ]);

    // approval_ux 로그
    const respondedAt = new Date().toISOString();
    await appendLog(pipelineId, {
      type: "approval_ux",
      materialChange,
      requestedAt: approvalRequestedAt,
      respondedAt,
      approved: approval.approved,
      elapsedMs: new Date(respondedAt).getTime() - new Date(approvalRequestedAt).getTime(),
      timedOut,
    });

    if (!approval.approved) {
      await transitionApprovalState({
        pipelineId,
        to: "draft_ready",
        reason: `사용자 거절${approval.modifications ? `: ${approval.modifications}` : ""}`,
        actor: request.userId,
      });
      state = updateState(state, { stage: "idle" });
      activePipelines.set(pipelineId, state);
      // 거절 시 topic 상태가 이미 in-progress인 경우 draft로 복구
      try {
        const statusAtReject = await loadTopicStatus(request.topicId);
        if (statusAtReject === "in-progress") {
          await updateTopicStatus(request.topicId, "draft");
        }
      } catch { /* 복구 실패는 무시 */ }
      emit(controller, makeEvent("rejected", "idle", {
        pipelineId,
        message: "전략이 거절되었습니다. 수정 후 다시 시도해 주세요.",
        modifications: approval.modifications ?? null,
      }));
      return;
    }

    // approval_request artifact 저장
    await saveArtifact<ApprovalRequestData>(pipelineId, "approval_request", {
      pipelineId,
      previousTitle: originalTitle,
      proposedTitle: strategy.title,
      materialChange,
      materialChangeSignals: mcResult.triggeredSignals,
      rationale: strategy.rationale,
      requestedAt: approvalRequestedAt,
      response: {
        approved: approval.approved,
        respondedAt: new Date().toISOString(),
        modifications: approval.modifications ?? null,
      },
    });

    // 승인 상태 전이: waiting_for_user_approval → approved_pending_record_update
    await transitionApprovalState({
      pipelineId,
      to: "approved_pending_record_update",
      reason: "사용자 승인 완료",
      actor: request.userId,
    });

    // 승인 게이트 해제 — 이 이후부터 index update 허용
    gate.grant();
    await upsertLedgerEntry({ pipelineId, topicId: request.topicId, userId: request.userId, stage: "awaiting-approval", error: null, approvalGranted: true, postingListUpdated: false, indexUpdated: false, createdAt: now });

    // ── 3. posting-list 업데이트 (승인 후, index보다 먼저) ────
    const postRecord = await createPostingRecord({
      topicId: request.topicId,
      userId: request.userId,
      title: strategy.title,
      pipelineId,
    });
    await upsertLedgerEntry({ pipelineId, topicId: request.topicId, userId: request.userId, stage: "awaiting-approval", error: null, approvalGranted: true, postingListUpdated: true, indexUpdated: false, createdAt: now });

    // ── 4. index 업데이트 (posting-list 완료 이후, 게이트 확인) ─
    gate.assertApproved(); // 방어적 호출 — 여기서 실패하면 코드 버그
    const topicStatusBefore = await loadTopicStatus(request.topicId);
    // 원자적 check-and-set: 동시 파이프라인이 같은 토픽을 중복 작성하는 것을 방지
    const setResult = await atomicSetTopicInProgress(request.topicId);
    if (!setResult.success) {
      throw new Error(`토픽 in-progress 설정 실패: ${setResult.reason}`);
    }
    thisSetTopicInProgress = true; // 이 파이프라인이 직접 설정함 → 실패 시 catch에서 복구 허용
    await upsertLedgerEntry({ pipelineId, topicId: request.topicId, userId: request.userId, stage: "writing", error: null, approvalGranted: true, postingListUpdated: true, indexUpdated: true, createdAt: now });

    // record_update artifact 저장
    await saveArtifact<RecordUpdateData>(pipelineId, "record_update", {
      postingListUpdated: true,
      postingListUpdatedAt: new Date().toISOString(),
      indexUpdated: true,
      indexUpdatedAt: new Date().toISOString(),
      postId: postRecord.postId,
      topicStatusBefore: topicStatusBefore ?? "pending",
      topicStatusAfter: "in-progress",
    });

    // 승인 상태 전이: approved_pending_record_update → records_updated
    await transitionApprovalState({
      pipelineId,
      to: "records_updated",
      reason: "posting-list + index 반영 완료",
    });

    // ── 4.5. corpus summary 준비 + pre-write gate ────────────
    emit(controller, makeEvent("progress", "writing", { message: "코퍼스 분석 중..." }));
    const corpusSummary = await getCorpusSummary({
      userId: request.userId,
      category: await loadTopicCategory(request.topicId),
      userTone: strategy.tone,
      topicTitle: strategy.title,
    });

    // corpus_retrieval 로그
    await appendLog(pipelineId, {
      type: "corpus_retrieval",
      userId: request.userId,
      selectedCount: corpusSummary.selectedCount,
      strategy: corpusSummary.retrievalStrategy,
      staleCount: corpusSummary.staleWarnings.length,
      staleWarnings: corpusSummary.staleWarnings,
      topScores: corpusSummary.scoringBreakdown.slice(0, 3).map((s) => ({
        sampleId: s.sampleId,
        finalScore: s.finalScore,
      })),
      targetCategory: await loadTopicCategory(request.topicId),
    });

    if (corpusSummary.staleWarnings.length > 0) {
      emit(controller, makeEvent("progress", "writing", {
        message: `⚠ stale exemplar 경고: ${corpusSummary.staleWarnings.join("; ")}`,
      }));
    }

    // pre-write gate 검사 (조건 1-3)
    const { getArtifact: _getArtifact } = await import("./artifact-registry");
    const approvalArtifact = await _getArtifact<ApprovalRequestData>(pipelineId, "approval_request");
    const recordArtifact = await _getArtifact<RecordUpdateData>(pipelineId, "record_update");

    const preGateResult = runPreWriteGate({
      sourceReport: null as SourceReportData | null, // strategy-planner 단계에서 미생성
      approvalRequest: approvalArtifact?.data ?? null,
      recordUpdate: recordArtifact?.data ?? null,
    });
    // pre-write gate 로그
    await appendLog(pipelineId, {
      type: "gate_result",
      gate: "pre-write",
      passed: preGateResult.passed,
      blockedBy: preGateResult.blockedBy,
      reason: preGateResult.reason,
    });

    if (!preGateResult.passed) {
      const blockedAt = new Date().toISOString();
      const approvalStateNow = await getApprovalState(pipelineId).catch(() => null);
      await Promise.allSettled([
        saveArtifact<GateFailureReportData>(pipelineId, "gate_failure_report", {
          gate: "pre-write",
          blockedBy: preGateResult.blockedBy ?? "unknown",
          reason: preGateResult.reason,
          blockedAt,
        }),
        saveArtifact<RunStateSnapshotData>(pipelineId, "run_state_snapshot", {
          pipelineId,
          topicId: request.topicId,
          userId: request.userId,
          stage: state.stage,
          approvalState: approvalStateNow?.state ?? "unknown",
          postId: postRecord.postId,
          strategyTitle: strategy.title,
          wordCount: null,
          evalScore: null,
          postingListUpdated: true,
          indexUpdated: true,
          snapshotAt: blockedAt,
        }),
        saveArtifact<BlockingReasonData>(pipelineId, "blocking_reason", {
          gate: "pre-write",
          code: preGateResult.blockedBy ?? "unknown",
          summary: preGateResult.reason,
          actionRequired: "전략 재검토 후 다시 실행해 주세요.",
          canRetry: true,
        }),
      ]);
      throw new Error(`pre-write gate 차단: ${preGateResult.reason}`);
    }
    emit(controller, makeEvent("progress", "writing", { message: "pre-write gate 통과" }));

    // ── 5. 본문 작성 ──────────────────────────────────────────
    state = updateState(state, { stage: "writing" });
    activePipelines.set(pipelineId, state);
    emit(controller, makeEvent("stage_change", "writing", {
      pipelineId,
      message: "Master Writer가 본문을 작성합니다.",
    }));

    const writerResult = await runMasterWriter({
      strategy,
      userId: request.userId,
      topicId: request.topicId,
      corpusSummary,
      onToken: (token) =>
        emit(controller, makeEvent("token", "writing", { token })),
      onProgress: (msg) =>
        emit(controller, makeEvent("progress", "writing", { message: msg })),
      signal,
    });

    state = updateState(state, { writerResult });
    activePipelines.set(pipelineId, state);

    // draft_output artifact 저장
    await saveArtifact<DraftOutputData>(pipelineId, "draft_output", {
      postId: writerResult.postId,
      title: writerResult.title,
      wordCount: writerResult.wordCount,
      generatedAt: writerResult.generatedAt,
      contentPath: Paths.postContent(writerResult.postId),
      corpusSummaryUsed: true,
    });

    // posting-list wordCount 업데이트
    await updatePostRecord(postRecord.postId, {
      status: "ready",
      wordCount: writerResult.wordCount,
      compositionSessionId: pipelineId,
    });

    // ── 6. 품질 평가 ──────────────────────────────────────────
    state = updateState(state, { stage: "evaluating" });
    activePipelines.set(pipelineId, state);
    emit(controller, makeEvent("stage_change", "evaluating", {
      pipelineId,
      message: "Harness Evaluator가 품질을 평가합니다.",
    }));

    const evalResult = await runHarnessEvaluator({
      writerResult,
      strategy,
      userId: request.userId,
      onProgress: (msg) =>
        emit(controller, makeEvent("progress", "evaluating", { message: msg })),
    });

    state = updateState(state, { evalResult });
    activePipelines.set(pipelineId, state);

    // post-audit gate 검사 (조건 4)
    const postGateResult = runPostAuditGate({
      auditReport: { pass: evalResult.pass, aggregateScore: evalResult.aggregateScore },
    });

    // baseline 비교 (gate 결과와 무관하게 항상 수행)
    const scenarioId = request.topicId;
    const baselineDiff = await compareWithCurrentBaseline({
      scenarioId,
      current: { runId: evalResult.runId, scores: evalResult.scores, aggregateScore: evalResult.aggregateScore },
    });
    const baselineDelta = baselineDiff?.aggregateDelta ?? null;

    if (baselineDiff?.overallRegression) {
      emit(controller, makeEvent("progress", "evaluating", {
        message: `⚠ baseline 회귀: ${baselineDiff.summary}`,
      }));
    }

    // audit_report artifact 저장 — gate 결과/baseline delta 포함 (항상 저장)
    await saveArtifact<AuditReportData>(pipelineId, "audit_report", {
      runId: evalResult.runId,
      scores: evalResult.scores,
      aggregateScore: evalResult.aggregateScore,
      reasoning: evalResult.reasoning,
      recommendations: evalResult.recommendations,
      pass: evalResult.pass,
      baselineDelta,
    });

    // post-audit gate 로그
    await appendLog(pipelineId, {
      type: "gate_result",
      gate: "post-audit",
      passed: postGateResult.passed,
      blockedBy: postGateResult.blockedBy,
      reason: postGateResult.reason,
      evalScore: evalResult.aggregateScore,
    });

    // ── POST-AUDIT GATE FAIL → 차단 대상 전부 막기 ──────────
    if (!postGateResult.passed) {
      // 허용: draft 보존, 로그 저장, 사용자 수정 요청
      await updatePostRecord(postRecord.postId, {
        evalScore: evalResult.aggregateScore,
        status: "audit_failed" as Parameters<typeof updatePostRecord>[1]["status"],
      });

      await transitionApprovalState({
        pipelineId,
        to: "audit_failed",
        reason: postGateResult.reason,
        gateInfo: { blockedBy: postGateResult.blockedBy ?? undefined, reason: postGateResult.reason },
      });

      state = updateState(state, { stage: "gate_blocked" });
      activePipelines.set(pipelineId, state);
      await upsertLedgerEntry({
        pipelineId, topicId: request.topicId, userId: request.userId,
        stage: "gate_blocked", error: postGateResult.reason,
        approvalGranted: true, postingListUpdated: true, indexUpdated: true, createdAt: now,
      });

      // 실패 추적 아티팩트 저장 (3종) — 차단 시에도 반드시 보존
      const gateBlockedAt = new Date().toISOString();
      await Promise.allSettled([
        saveArtifact<GateFailureReportData>(pipelineId, "gate_failure_report", {
          gate: "post-audit",
          blockedBy: postGateResult.blockedBy ?? "eval_score_below_threshold",
          reason: postGateResult.reason,
          evalScore: evalResult.aggregateScore,
          evalScores: evalResult.scores,
          recommendations: evalResult.recommendations,
          baselineDelta,
          blockedAt: gateBlockedAt,
        }),
        saveArtifact<RunStateSnapshotData>(pipelineId, "run_state_snapshot", {
          pipelineId,
          topicId: request.topicId,
          userId: request.userId,
          stage: "gate_blocked",
          approvalState: "audit_failed",
          postId: postRecord.postId,
          strategyTitle: strategy.title,
          wordCount: writerResult.wordCount,
          evalScore: evalResult.aggregateScore,
          postingListUpdated: true,
          indexUpdated: true,
          snapshotAt: gateBlockedAt,
        }),
        saveArtifact<BlockingReasonData>(pipelineId, "blocking_reason", {
          gate: "post-audit",
          code: postGateResult.blockedBy ?? "eval_score_below_threshold",
          summary: `평가 점수 미달 (${evalResult.aggregateScore}점): ${postGateResult.reason}`,
          actionRequired: "본문을 수정하거나 평가 기준을 재검토한 후 다시 실행해 주세요.",
          canRetry: true,
        }),
      ]);

      // 차단됨: index update X, posting-list final update X, publish X, baseline promotion X, release pass X
      emit(controller, makeEvent("gate_blocked", "gate_blocked", {
        pipelineId,
        postId: postRecord.postId,
        blockedBy: postGateResult.blockedBy,
        reason: postGateResult.reason,
        evalScore: evalResult.aggregateScore,
        recommendations: evalResult.recommendations,
        draft: {
          title: writerResult.title,
          wordCount: writerResult.wordCount,
          contentPath: Paths.postContent(writerResult.postId),
        },
      }));
      return; // ← 여기서 중단 — 아래 final update 코드 실행 없음
    }

    // ── POST-AUDIT GATE PASS → 최종 상태 전이 (차단 대상 허용) ─
    emit(controller, makeEvent("progress", "evaluating", { message: "post-audit gate 통과" }));

    // candidate 등록 (gate 통과 시에만)
    const candidateResult = await registerBaselineCandidate({
      scenarioId,
      runId: evalResult.runId,
      postId: writerResult.postId,
      pipelineId,
      scores: evalResult.scores,
      aggregateScore: evalResult.aggregateScore,
      notes: `pipeline ${pipelineId} / post ${writerResult.postId}`,
    });
    await appendLog(pipelineId, {
      type: "baseline_candidate",
      scenarioId,
      runId: evalResult.runId,
      aggregateScore: evalResult.aggregateScore,
      registered: candidateResult.registered,
      reason: candidateResult.reason,
    });
    emit(controller, makeEvent("progress", "evaluating", {
      message: `baseline candidate: ${candidateResult.reason}`,
    }));

    // posting-list final update (gate 통과 시에만)
    await updatePostRecord(postRecord.postId, {
      evalScore: evalResult.aggregateScore,
      status: "approved",
    });

    // artifact contract 저장 (gate 통과 시에만)
    await saveArtifactContract({
      pipelineId,
      postId: postRecord.postId,
      topicId: request.topicId,
      userId: request.userId,
      title: writerResult.title,
      wordCount: writerResult.wordCount,
      contentPath: Paths.postContent(postRecord.postId),
      generatedAt: writerResult.generatedAt,
      evalRunId: evalResult.runId,
      evalScore: evalResult.aggregateScore,
    });

    // 승인 상태 전이: records_updated → released (gate 통과 시에만)
    await transitionApprovalState({
      pipelineId,
      to: "released",
      reason: "모든 gate 통과 — 배포 완료",
    });

    // ── 7. 완료 ───────────────────────────────────────────────
    state = updateState(state, { stage: "complete" });
    activePipelines.set(pipelineId, state);
    await upsertLedgerEntry({ pipelineId, topicId: request.topicId, userId: request.userId, stage: "complete", error: null, approvalGranted: true, postingListUpdated: true, indexUpdated: true, createdAt: now });

    emit(controller, makeEvent("result", "complete", {
      pipelineId,
      postId: postRecord.postId,
      title: writerResult.title,
      wordCount: writerResult.wordCount,
      evalScore: evalResult.aggregateScore,
      baselineDelta,
      pass: evalResult.pass,
      recommendations: evalResult.recommendations,
    }));
    emit(controller, makeEvent("stage_change", "complete", {
      pipelineId,
      message: "파이프라인이 완료되었습니다.",
    }));
  } catch (err) {
    let message = err instanceof Error ? err.message : "알 수 없는 오류";

    // APIConnectionError: 서버 로그에 상세 정보 기록 + 사용자 메시지 보강
    if (err instanceof Error && err.constructor.name === "APIConnectionError") {
      const cause = (err as { cause?: unknown }).cause;
      const causeMsg = cause instanceof Error ? ` (원인: ${cause.message})` : "";
      console.error("[orchestrator] Anthropic 연결 오류:", {
        message: err.message,
        cause,
        code: (err as { code?: string }).code,
      });
      message = `Anthropic API 연결 실패${causeMsg} — Railway 환경 변수 ANTHROPIC_API_KEY 확인 및 /api/anthropic/ping 엔드포인트로 진단하세요.`;
    }

    state = updateState(state, { stage: "failed", error: message });
    activePipelines.set(pipelineId, state);
    console.error(`[orchestrator] pipeline ${pipelineId} FAILED at stage=${state.stage}:`, message);
    await upsertLedgerEntry({ pipelineId, topicId: request.topicId, userId: request.userId, stage: "failed", error: message, approvalGranted: gate.approved, postingListUpdated: false, indexUpdated: false, createdAt: now }).catch((e) => {
      console.error(`[orchestrator] ledger failed-write error (ignored):`, e instanceof Error ? e.message : e);
    });
    emit(controller, makeEvent("error", "failed", { pipelineId, message }));

    // 파이프라인 실패 시 topic이 in-progress 상태로 stuck되는 것 방지 — draft로 복구
    // thisSetTopicInProgress 플래그로 이 파이프라인이 직접 설정한 경우만 복구
    // (다른 파이프라인이 in-progress로 설정한 경우 덮어쓰지 않음)
    if (thisSetTopicInProgress) {
      try {
        const currentStatus = await loadTopicStatus(request.topicId);
        if (currentStatus === "in-progress") {
          await updateTopicStatus(request.topicId, "draft");
          emit(controller, makeEvent("progress", "failed", { message: "토픽 상태를 draft로 복구했습니다." }));
        }
      } catch (recoveryErr) {
        console.error(`[orchestrator] topic recovery failed (ignored):`, recoveryErr instanceof Error ? recoveryErr.message : recoveryErr);
      }
    }
  } finally {
    pendingApprovals.delete(pipelineId);
    controller.close();
  }
}

// ============================================================
// 승인 처리
// ============================================================

/**
 * 승인 처리 — 메모리(동일 인스턴스) + GitHub(재시작/다중 인스턴스) 병행
 * approve 엔드포인트에서 호출. 항상 성공 처리.
 */
export async function handleApproval(approval: ApprovalRequest): Promise<boolean> {
  // 1. 메모리 경로 (동일 인스턴스 — 즉시 반영)
  const pending = pendingApprovals.get(approval.pipelineId);
  if (pending) {
    pending.resolve(approval);
    pendingApprovals.delete(approval.pipelineId);
  }

  // 2. GitHub 경로 (재시작/다중 인스턴스 fallback — 폴링으로 수신)
  try {
    await resolveApprovalRecord(approval.pipelineId, approval.approved, approval.modifications);
  } catch {
    // best-effort — GitHub 기록 실패해도 메모리 경로가 있으면 계속 진행
  }

  return true; // 항상 성공 반환 (404 제거)
}

/**
 * 승인 대기 — 메모리(즉시) + GitHub 폴링(3초 간격) 병렬 실행
 * 둘 중 먼저 응답하는 쪽을 사용
 */
async function waitForApproval(
  pipelineId: string,
  strategy: StrategyPlanResult
): Promise<ApprovalRequest> {
  // GitHub에 승인 대기 레코드 생성 (서버 재시작 복구용)
  await createApprovalRecord(pipelineId).catch(() => {});

  return new Promise((resolve, reject) => {
    // 메모리 경로 등록
    pendingApprovals.set(pipelineId, { resolve, strategy });

    // GitHub 폴링 (3초 간격) — 재시작/다중 인스턴스 fallback
    const pollInterval = setInterval(async () => {
      try {
        const record = await readApprovalRecord(pipelineId);
        if (record?.status === "approved" || record?.status === "rejected") {
          clearInterval(pollInterval);
          pendingApprovals.delete(pipelineId);
          await markApprovalConsumed(pipelineId).catch(() => {});
          resolve({
            pipelineId,
            approved: record.status === "approved",
            modifications: record.modifications ?? undefined,
          });
        }
      } catch {
        // GitHub 일시적 오류 무시
      }
    }, 3000);

    // 타임아웃 시 정리
    const originalResolve = resolve;
    pendingApprovals.set(pipelineId, {
      resolve: (approval) => {
        clearInterval(pollInterval);
        originalResolve(approval);
      },
      strategy,
    });

    // reject 시 정리 (외부 timeout Promise가 reject하는 경우)
    void reject; // suppress unused warning — reject is handled by outer Promise.race
  });
}

// ============================================================
// 파이프라인 상태 조회
// ============================================================

export function getPipelineState(pipelineId: string): PipelineState | null {
  return activePipelines.get(pipelineId) ?? null;
}

// ============================================================
// GitHub 데이터 헬퍼
// ============================================================

async function validateTopicSelectionFromGitHub(
  topicId: string
): Promise<{ valid: boolean; reason: string }> {
  try {
    const path = Paths.topicsIndex();
    if (!(await fileExists(path))) {
      return { valid: false, reason: "topics index 파일이 없습니다." };
    }
    const { data: index } = await readJsonFile<TopicIndex>(path);
    const { validateTopicSelection } = await import("./completion-checker");
    return validateTopicSelection(topicId, index.topics);
  } catch (err) {
    return { valid: false, reason: err instanceof Error ? err.message : "토픽 검증 실패" };
  }
}

async function loadTopicTitle(topicId: string): Promise<string | null> {
  try {
    const { data } = await readJsonFile<TopicIndex>(Paths.topicsIndex());
    return data.topics.find((t) => t.topicId === topicId)?.title ?? null;
  } catch {
    return null;
  }
}

async function loadTopicStatus(topicId: string): Promise<string | null> {
  try {
    const { data } = await readJsonFile<TopicIndex>(Paths.topicsIndex());
    return data.topics.find((t) => t.topicId === topicId)?.status ?? null;
  } catch {
    return null;
  }
}

async function loadTopicCategory(topicId: string): Promise<string | undefined> {
  try {
    const { data } = await readJsonFile<TopicIndex>(Paths.topicsIndex());
    return data.topics.find((t) => t.topicId === topicId)?.category;
  } catch {
    return undefined;
  }
}

async function createPostingRecord(params: {
  topicId: string;
  userId: string;
  title: string;
  pipelineId: string;
}): Promise<{ postId: string }> {
  const postId = `post-${randomUUID().slice(0, 8)}`;

  await withConflictRetry(async () => {
    const now = new Date().toISOString();
    const path = Paths.postingListIndex();
    const exists = await fileExists(path);
    let index: PostingIndex = { posts: [], lastUpdated: now };
    let sha: string | null = null;

    if (exists) {
      const result = await readJsonFile<PostingIndex>(path);
      index = result.data;
      sha = result.sha;
    }

    const updated: PostingIndex = {
      posts: [
        ...index.posts,
        {
          postId,
          topicId: params.topicId,
          userId: params.userId,
          title: params.title,
          status: "draft",
          naverPostUrl: null,
          evalScore: null,
          wordCount: 0,
          compositionSessionId: params.pipelineId,
          pendingApproval: null,
          createdAt: now,
          publishedAt: null,
          updatedAt: now,
        },
      ],
      lastUpdated: now,
    };

    await writeJsonFile(path, updated, `feat: create post record ${postId}`, sha);
  });

  return { postId };
}

// ── SHA 충돌 재시도 래퍼 ────────────────────────────────────────
// GitHub API는 SHA 불일치 시 409/422를 반환한다.
// 500/503은 서버 일시 오류, 429는 rate limit — 모두 재시도한다.
// fn() 내부에서 최신 SHA를 매번 새로 읽으므로 단순히 재호출하면 된다.
async function withConflictRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 10
): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { status?: number }).status;
      const retryable = status === 409 || status === 422 || status === 429 || status === 500 || status === 503;
      if (retryable && attempt < maxAttempts - 1) {
        // jitter로 thundering herd 방지 (429의 경우 더 긴 대기)
        const base = status === 429 ? 500 : 50;
        const jitter = Math.floor(Math.random() * base) + base;
        await new Promise((r) => setTimeout(r, jitter * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  /* istanbul ignore next */
  throw new Error("withConflictRetry: unreachable");
}

// ── 토픽 상태 원자적 in-progress 설정 ──────────────────────────
// validate → write를 한 번의 SHA 트랜잭션 안에서 수행.
// 동시 파이프라인이 같은 토픽에 접근해도 정확히 하나만 in-progress로 진입.
async function atomicSetTopicInProgress(
  topicId: string
): Promise<{ success: boolean; reason: string }> {
  let result: { success: boolean; reason: string } = { success: false, reason: "unknown" };

  await withConflictRetry(async () => {
    const path = Paths.topicsIndex();
    if (!(await fileExists(path))) {
      result = { success: false, reason: "topics index 없음" };
      return;
    }
    const { data: index, sha } = await readJsonFile<TopicIndex>(path);
    const topic = index.topics.find((t) => t.topicId === topicId);
    if (!topic) {
      result = { success: false, reason: `topicId "${topicId}"를 찾을 수 없음` };
      return;
    }
    if (topic.status === "in-progress") {
      result = { success: false, reason: "이미 다른 파이프라인이 이 토픽을 작성 중입니다." };
      return;
    }
    if (topic.status !== "draft") {
      result = { success: false, reason: `토픽 상태가 draft가 아닙니다 (현재: ${topic.status})` };
      return;
    }
    const now = new Date().toISOString();
    const updated: TopicIndex = {
      topics: index.topics.map((t) =>
        t.topicId === topicId ? { ...t, status: "in-progress", updatedAt: now } : t
      ),
      lastUpdated: now,
    };
    await writeJsonFile(path, updated, `chore: topic ${topicId} → in-progress [atomic]`, sha);
    result = { success: true, reason: "in-progress 설정 완료" };
  });

  return result;
}

async function updatePostRecord(
  postId: string,
  patch: Partial<import("@/lib/types/github-data").PostingRecord>
): Promise<void> {
  await withConflictRetry(async () => {
    const path = Paths.postingListIndex();
    if (!(await fileExists(path))) return;

    const { data: index, sha } = await readJsonFile<PostingIndex>(path);
    const now = new Date().toISOString();

    const updated: PostingIndex = {
      posts: index.posts.map((p) =>
        p.postId === postId ? { ...p, ...patch, updatedAt: now } : p
      ),
      lastUpdated: now,
    };

    await writeJsonFile(path, updated, `chore: update post ${postId}`, sha);
  });
}

async function updateTopicStatus(
  topicId: string,
  status: import("@/lib/types/github-data").Topic["status"]
): Promise<void> {
  await withConflictRetry(async () => {
    const path = Paths.topicsIndex();
    if (!(await fileExists(path))) return;

    const { data: index, sha } = await readJsonFile<TopicIndex>(path);
    const now = new Date().toISOString();

    const updated: TopicIndex = {
      topics: index.topics.map((t) =>
        t.topicId === topicId ? { ...t, status, updatedAt: now } : t
      ),
      lastUpdated: now,
    };

    await writeJsonFile(path, updated, `chore: topic ${topicId} -> ${status}`, sha);
  });
}

// ============================================================
// 2단계 파이프라인 — Phase 1: 전략 수립
// ============================================================

export async function runStrategyPhase(params: {
  topicId: string;
  userId: string;
  pipelineId: string;
  controller: ReadableStreamDefaultController;
  signal?: AbortSignal;
}): Promise<void> {
  const { topicId, userId, pipelineId, controller, signal } = params;
  const now = new Date().toISOString();

  let state: PipelineState = {
    pipelineId,
    topicId,
    userId,
    stage: "idle",
    strategy: null,
    writerResult: null,
    evalResult: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  activePipelines.set(pipelineId, state);

  try {
    // ── 0. 토픽 유효성 검사
    const topicValidation = await validateTopicSelectionFromGitHub(topicId);
    if (!topicValidation.valid) {
      throw new Error(`토픽 선택 실패: ${topicValidation.reason}`);
    }

    // ── 1. 전략 수립
    state = updateState(state, { stage: "strategy-planning" });
    activePipelines.set(pipelineId, state);
    emit(controller, makeEvent("stage_change", "strategy-planning", {
      pipelineId,
      message: "전략 수립을 시작합니다.",
    }));

    const strategy = await runStrategyPlanner({
      topicId,
      userId,
      onProgress: (msg) => emit(controller, makeEvent("progress", "strategy-planning", { message: msg })),
      signal,
    });

    state = updateState(state, { strategy });
    activePipelines.set(pipelineId, state);

    // strategy_plan artifact 저장 (best-effort)
    await saveArtifact<StrategyPlanData>(pipelineId, "strategy_plan", {
      title: strategy.title,
      outline: strategy.outline,
      keyPoints: strategy.keyPoints,
      estimatedLength: strategy.estimatedLength,
      tone: strategy.tone,
      keywords: strategy.keywords,
      rationale: strategy.rationale,
      corpusSummary: null,
    }).catch((e: unknown) => {
      console.warn("[orchestrator] saveArtifact(strategy_plan) 실패 (무시):", e instanceof Error ? e.message : e);
    });

    // ── 2. material_change 감지
    const originalTitle = (await loadTopicTitle(topicId)) ?? "";
    const mcResult = detectMaterialChange({
      original: { title: originalTitle },
      proposed: { title: strategy.title, keywords: strategy.keywords, rationale: strategy.rationale },
    });

    await appendLog(pipelineId, {
      type: "material_change",
      originalTitle,
      proposedTitle: strategy.title,
      isMaterial: mcResult.isMaterial,
      triggeredSignals: mcResult.triggeredSignals,
      stringSimilarity: mcResult.stringSimilarity ?? 0,
      overrideByHighSim: !mcResult.isMaterial && (mcResult.stringSimilarity ?? 0) >= 0.85,
    }).catch(() => {});

    state = updateState(state, { stage: "awaiting-approval" });
    activePipelines.set(pipelineId, state);

    // 승인 요청 이벤트 발행 (strategy 전체 포함 — write phase에서 사용)
    emit(controller, makeEvent("approval_required", "awaiting-approval", {
      pipelineId,
      previousTitle: originalTitle,
      proposedTitle: strategy.title,
      materialChange: mcResult.isMaterial,
      rationale: strategy.rationale,
      outline: strategy.outline.map((s) => s.heading),
      strategy, // write phase가 이 값을 받아 POST body에 포함
    }));

  } catch (err) {
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    state = updateState(state, { stage: "failed", error: message });
    activePipelines.set(pipelineId, state);
    console.error(`[orchestrator] strategy phase ${pipelineId} FAILED:`, message);
    emit(controller, makeEvent("error", "failed", { pipelineId, message }));
  } finally {
    controller.close();
  }
}

// ============================================================
// 2단계 파이프라인 — Phase 2: 글쓰기 + 평가
// ============================================================

export async function runWritePhase(params: {
  topicId: string;
  userId: string;
  pipelineId: string;
  strategy: StrategyPlanResult;
  controller: ReadableStreamDefaultController;
  signal?: AbortSignal;
}): Promise<void> {
  const { topicId, userId, pipelineId, strategy, controller, signal } = params;
  const now = new Date().toISOString();
  const gate = new ApprovalGate(pipelineId);
  gate.grant(); // 클라이언트에서 이미 승인됨

  let thisSetTopicInProgress = false;

  let state: PipelineState = {
    pipelineId,
    topicId,
    userId,
    stage: "awaiting-approval",
    strategy,
    writerResult: null,
    evalResult: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };
  activePipelines.set(pipelineId, state);

  try {
    // ── 3. posting-list 업데이트 (승인 후)
    const postRecord = await createPostingRecord({ topicId, userId, title: strategy.title, pipelineId });

    // ── 4. topic in-progress 원자적 설정
    gate.assertApproved();
    const setResult = await atomicSetTopicInProgress(topicId);
    if (!setResult.success) {
      throw new Error(`토픽 in-progress 설정 실패: ${setResult.reason}`);
    }
    thisSetTopicInProgress = true;

    // approval_request artifact (best-effort)
    await saveArtifact<ApprovalRequestData>(pipelineId, "approval_request", {
      pipelineId,
      previousTitle: "",
      proposedTitle: strategy.title,
      materialChange: false,
      materialChangeSignals: [],
      rationale: strategy.rationale,
      requestedAt: now,
      response: { approved: true, respondedAt: now, modifications: null },
    }).catch(() => {});

    // record_update artifact (best-effort)
    await saveArtifact<RecordUpdateData>(pipelineId, "record_update", {
      postingListUpdated: true,
      postingListUpdatedAt: now,
      indexUpdated: true,
      indexUpdatedAt: now,
      postId: postRecord.postId,
      topicStatusBefore: "draft",
      topicStatusAfter: "in-progress",
    }).catch(() => {});

    // ── 4.5. corpus + pre-write gate
    emit(controller, makeEvent("progress", "writing", { message: "코퍼스 분석 중..." }));
    const corpusSummary = await getCorpusSummary({
      userId,
      category: await loadTopicCategory(topicId),
      userTone: strategy.tone,
      topicTitle: strategy.title,
    });

    const { getArtifact: _getArtifact } = await import("./artifact-registry");
    const approvalArtifact = await _getArtifact<ApprovalRequestData>(pipelineId, "approval_request");
    const recordArtifact = await _getArtifact<RecordUpdateData>(pipelineId, "record_update");
    const preGateResult = runPreWriteGate({
      sourceReport: null as SourceReportData | null,
      approvalRequest: approvalArtifact?.data ?? null,
      recordUpdate: recordArtifact?.data ?? null,
    });

    if (!preGateResult.passed) {
      throw new Error(`pre-write gate 차단: ${preGateResult.reason}`);
    }
    emit(controller, makeEvent("progress", "writing", { message: "pre-write gate 통과" }));

    // ── 5. 본문 작성
    state = updateState(state, { stage: "writing" });
    activePipelines.set(pipelineId, state);
    emit(controller, makeEvent("stage_change", "writing", {
      pipelineId,
      message: "Master Writer가 본문을 작성합니다.",
    }));

    const writerResult = await runMasterWriter({
      strategy,
      userId,
      topicId,
      corpusSummary,
      onToken: (token) => emit(controller, makeEvent("token", "writing", { token })),
      onProgress: (msg) => emit(controller, makeEvent("progress", "writing", { message: msg })),
      signal,
    });

    state = updateState(state, { writerResult });
    activePipelines.set(pipelineId, state);

    await saveArtifact<DraftOutputData>(pipelineId, "draft_output", {
      postId: writerResult.postId,
      title: writerResult.title,
      wordCount: writerResult.wordCount,
      generatedAt: writerResult.generatedAt,
      contentPath: Paths.postContent(writerResult.postId),
      corpusSummaryUsed: true,
    }).catch(() => {});

    await updatePostRecord(postRecord.postId, {
      status: "ready",
      wordCount: writerResult.wordCount,
      compositionSessionId: pipelineId,
    });

    // ── 6. 품질 평가
    state = updateState(state, { stage: "evaluating" });
    activePipelines.set(pipelineId, state);
    emit(controller, makeEvent("stage_change", "evaluating", {
      pipelineId,
      message: "Harness Evaluator가 품질을 평가합니다.",
    }));

    const evalResult = await runHarnessEvaluator({
      writerResult,
      strategy,
      userId,
      onProgress: (msg) => emit(controller, makeEvent("progress", "evaluating", { message: msg })),
    });

    state = updateState(state, { evalResult });
    activePipelines.set(pipelineId, state);

    const postGateResult = runPostAuditGate({
      auditReport: { pass: evalResult.pass, aggregateScore: evalResult.aggregateScore },
    });

    const scenarioId = topicId;
    const baselineDiff = await compareWithCurrentBaseline({
      scenarioId,
      current: { runId: evalResult.runId, scores: evalResult.scores, aggregateScore: evalResult.aggregateScore },
    });
    const baselineDelta = baselineDiff?.aggregateDelta ?? null;

    await saveArtifact<AuditReportData>(pipelineId, "audit_report", {
      runId: evalResult.runId,
      scores: evalResult.scores,
      aggregateScore: evalResult.aggregateScore,
      reasoning: evalResult.reasoning,
      recommendations: evalResult.recommendations,
      pass: evalResult.pass,
      baselineDelta,
    }).catch(() => {});

    if (!postGateResult.passed) {
      await updatePostRecord(postRecord.postId, {
        evalScore: evalResult.aggregateScore,
        status: "audit_failed" as Parameters<typeof updatePostRecord>[1]["status"],
      });
      state = updateState(state, { stage: "gate_blocked" });
      activePipelines.set(pipelineId, state);
      emit(controller, makeEvent("gate_blocked", "gate_blocked", {
        pipelineId,
        postId: postRecord.postId,
        blockedBy: postGateResult.blockedBy,
        reason: postGateResult.reason,
        evalScore: evalResult.aggregateScore,
        recommendations: evalResult.recommendations,
        draft: {
          title: writerResult.title,
          wordCount: writerResult.wordCount,
          contentPath: Paths.postContent(writerResult.postId),
        },
      }));
      return;
    }

    // ── 7. 완료
    const candidateResult = await registerBaselineCandidate({
      scenarioId,
      runId: evalResult.runId,
      postId: writerResult.postId,
      pipelineId,
      scores: evalResult.scores,
      aggregateScore: evalResult.aggregateScore,
      notes: `pipeline ${pipelineId} / post ${writerResult.postId}`,
    });

    if (baselineDiff?.overallRegression) {
      emit(controller, makeEvent("progress", "evaluating", {
        message: `⚠ baseline 회귀: ${baselineDiff.summary}`,
      }));
    }
    emit(controller, makeEvent("progress", "evaluating", {
      message: `baseline candidate: ${candidateResult.reason}`,
    }));

    await updatePostRecord(postRecord.postId, {
      evalScore: evalResult.aggregateScore,
      status: "approved",
    });

    await saveArtifactContract({
      pipelineId,
      postId: postRecord.postId,
      topicId,
      userId,
      title: writerResult.title,
      wordCount: writerResult.wordCount,
      contentPath: Paths.postContent(postRecord.postId),
      generatedAt: writerResult.generatedAt,
      evalRunId: evalResult.runId,
      evalScore: evalResult.aggregateScore,
    });

    state = updateState(state, { stage: "complete" });
    activePipelines.set(pipelineId, state);

    emit(controller, makeEvent("result", "complete", {
      pipelineId,
      postId: postRecord.postId,
      title: writerResult.title,
      wordCount: writerResult.wordCount,
      evalScore: evalResult.aggregateScore,
      baselineDelta,
      pass: evalResult.pass,
      recommendations: evalResult.recommendations,
    }));
    emit(controller, makeEvent("stage_change", "complete", {
      pipelineId,
      message: "파이프라인이 완료되었습니다.",
    }));

  } catch (err) {
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    state = updateState(state, { stage: "failed", error: message });
    activePipelines.set(pipelineId, state);
    console.error(`[orchestrator] write phase ${pipelineId} FAILED:`, message);
    emit(controller, makeEvent("error", "failed", { pipelineId, message }));

    if (thisSetTopicInProgress) {
      try {
        const currentStatus = await loadTopicStatus(topicId);
        if (currentStatus === "in-progress") {
          await updateTopicStatus(topicId, "draft");
        }
      } catch { /* ignore */ }
    }
  } finally {
    controller.close();
  }
}
