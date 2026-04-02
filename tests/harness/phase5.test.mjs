/**
 * Phase 5 테스트 — gate 차단 상태 전이 + approval state machine + operation logger
 *
 * 검증:
 *   1. post-audit gate fail → 차단 대상 전부 막힘
 *   2. approval state machine 전이 순서
 *   3. force transition (관리자 복구)
 *   4. operation logger 로그 수집 + 품질 리포트
 *   5. audit_failed 상태에서 released 직접 전이 불가
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ============================================================
// In-memory GitHub mock
// ============================================================

let store = new Map();

const gh = {
  async fileExists(p) { return store.has(p); },
  async readJsonFile(p) {
    if (!store.has(p)) throw new Error(`Not found: ${p}`);
    const e = store.get(p);
    return { data: e.data, sha: e.sha };
  },
  async writeJsonFile(p, data, _msg, _sha) {
    const sha = `sha-${Math.random().toString(36).slice(2, 9)}`;
    store.set(p, { data, sha });
    return sha;
  },
};

// ============================================================
// Approval state machine (inline mirror)
// ============================================================

const ALLOWED_TRANSITIONS = {
  draft_ready:                    ["waiting_for_user_approval"],
  waiting_for_user_approval:      ["approved_pending_record_update", "draft_ready"],
  approved_pending_record_update: ["records_updated"],
  records_updated:                ["audit_failed", "released"],
  audit_failed:                   ["records_updated"],   // 관리자 복구
  released:                       [],
};

function statePath(pipelineId) {
  return `data/pipeline-ledger/approval-states/${pipelineId}.json`;
}

async function initApprovalState(params) {
  const path = statePath(params.pipelineId);
  const now = new Date().toISOString();
  const record = {
    pipelineId: params.pipelineId,
    topicId: params.topicId,
    userId: params.userId,
    state: "draft_ready",
    history: [{ from: null, to: "draft_ready", reason: "파이프라인 시작", at: now, actor: "system" }],
    createdAt: now,
    updatedAt: now,
  };
  await gh.writeJsonFile(path, record, "init", null);
  return record;
}

async function transitionApprovalState(params) {
  const path = statePath(params.pipelineId);
  if (!(await gh.fileExists(path))) return { success: false, error: "없음" };
  const { data: record, sha } = await gh.readJsonFile(path);
  const allowed = ALLOWED_TRANSITIONS[record.state];
  if (!allowed.includes(params.to)) {
    return { success: false, error: `전이 불가: ${record.state} → ${params.to}`, record };
  }
  const now = new Date().toISOString();
  const updated = {
    ...record,
    state: params.to,
    history: [...record.history, { from: record.state, to: params.to, reason: params.reason, at: now, actor: params.actor ?? "system" }],
    updatedAt: now,
    ...(params.to === "audit_failed" && params.gateInfo ? {
      gateBlockedBy: params.gateInfo.blockedBy,
      gateBlockedReason: params.gateInfo.reason,
      gateBlockedAt: now,
    } : {}),
  };
  await gh.writeJsonFile(path, updated, `state → ${params.to}`, sha);
  return { success: true, record: updated };
}

async function forceApprovalState(params) {
  const path = statePath(params.pipelineId);
  if (!(await gh.fileExists(path))) return { success: false, error: "없음" };
  const { data: record, sha } = await gh.readJsonFile(path);
  const now = new Date().toISOString();
  const updated = {
    ...record,
    state: params.to,
    history: [...record.history, { from: record.state, to: params.to, reason: `[FORCE] ${params.reason}`, at: now, actor: params.actor }],
    updatedAt: now,
  };
  await gh.writeJsonFile(path, updated, `force → ${params.to}`, sha);
  return { success: true, record: updated };
}

async function getApprovalState(pipelineId) {
  const path = statePath(pipelineId);
  if (!(await gh.fileExists(path))) return null;
  const { data } = await gh.readJsonFile(path);
  return data;
}

// ============================================================
// Operation logger (inline mirror)
// ============================================================

const LOG_PATH = "data/pipeline-ledger/operation-log.json";

async function appendLog(pipelineId, entry) {
  const exists = await gh.fileExists(LOG_PATH);
  const current = exists ? (await gh.readJsonFile(LOG_PATH)).data : { entries: [], lastUpdated: "" };
  const sha = exists ? (await gh.readJsonFile(LOG_PATH)).sha : null;
  const newEntry = { ...entry, pipelineId, at: new Date().toISOString() };
  await gh.writeJsonFile(LOG_PATH, { entries: [...current.entries, newEntry], lastUpdated: new Date().toISOString() }, "log", sha);
}

async function getLogEntries(filter = {}) {
  if (!(await gh.fileExists(LOG_PATH))) return [];
  const { data } = await gh.readJsonFile(LOG_PATH);
  let entries = data.entries;
  if (filter.type) entries = entries.filter(e => e.type === filter.type);
  if (filter.pipelineId) entries = entries.filter(e => e.pipelineId === filter.pipelineId);
  return entries;
}

// ============================================================
// Gate helpers
// ============================================================

function runPostAuditGate({ auditReport, minScore = 70 }) {
  if (!auditReport) return { passed: true, blockedBy: null, reason: "skip" };
  if (!auditReport.pass || auditReport.aggregateScore < minScore)
    return { passed: false, blockedBy: "audit_not_approved", reason: `점수 미달: ${auditReport.aggregateScore}점` };
  return { passed: true, blockedBy: null, reason: `통과: ${auditReport.aggregateScore}점` };
}

// ============================================================
// 시뮬레이션: pipeline run (축약 버전)
// ============================================================

async function simulatePipelineRun(pipelineId, evalScore) {
  const postId = `post-${pipelineId}`;
  const postingList = { posts: [], lastUpdated: "" };

  // init
  await initApprovalState({ pipelineId, topicId: "t-001", userId: "u-001" });

  // approval flow
  await transitionApprovalState({ pipelineId, to: "waiting_for_user_approval", reason: "승인 요청" });
  await transitionApprovalState({ pipelineId, to: "approved_pending_record_update", reason: "승인 완료" });

  // posting-list (draft)
  postingList.posts.push({ postId, topicId: "t-001", status: "draft", wordCount: 1200 });
  await gh.writeJsonFile("data/posting-list/index.json", postingList, "draft", null);

  // records updated
  await transitionApprovalState({ pipelineId, to: "records_updated", reason: "records 반영" });

  // eval
  const auditReport = { pass: evalScore >= 70, aggregateScore: evalScore };
  const postGate = runPostAuditGate({ auditReport });

  if (!postGate.passed) {
    // GATE FAIL: 차단 대상 막기
    // posting-list status → audit_failed (NOT "approved")
    const { data: list, sha } = await gh.readJsonFile("data/posting-list/index.json");
    await gh.writeJsonFile("data/posting-list/index.json",
      { posts: list.posts.map(p => p.postId === postId ? { ...p, status: "audit_failed", evalScore } : p), lastUpdated: "" },
      "audit_failed", sha
    );

    // approval state → audit_failed
    await transitionApprovalState({
      pipelineId, to: "audit_failed",
      reason: postGate.reason,
      gateInfo: { blockedBy: postGate.blockedBy, reason: postGate.reason },
    });

    // 로그
    await appendLog(pipelineId, { type: "gate_result", gate: "post-audit", passed: false, blockedBy: postGate.blockedBy, reason: postGate.reason, evalScore });

    return { stage: "gate_blocked", postStatus: "audit_failed", approvalState: "audit_failed" };
  }

  // GATE PASS: 모든 final update 허용
  const { data: list, sha } = await gh.readJsonFile("data/posting-list/index.json");
  await gh.writeJsonFile("data/posting-list/index.json",
    { posts: list.posts.map(p => p.postId === postId ? { ...p, status: "approved", evalScore } : p), lastUpdated: "" },
    "approved", sha
  );

  await transitionApprovalState({ pipelineId, to: "released", reason: "배포 완료" });
  await appendLog(pipelineId, { type: "gate_result", gate: "post-audit", passed: true, blockedBy: null, reason: postGate.reason, evalScore });

  return { stage: "complete", postStatus: "approved", approvalState: "released" };
}

// ============================================================
// 테스트
// ============================================================

describe("Phase 5 — post-audit gate fail 차단", () => {
  beforeEach(() => { store.clear(); });

  test("eval 점수 미달 → gate_blocked 단계, posting status=audit_failed", async () => {
    const result = await simulatePipelineRun("pipe-fail-001", 55);
    assert.equal(result.stage, "gate_blocked");
    assert.equal(result.postStatus, "audit_failed");
    assert.equal(result.approvalState, "audit_failed");

    // posting-list에서 status 확인
    const { data: list } = await gh.readJsonFile("data/posting-list/index.json");
    assert.equal(list.posts[0].status, "audit_failed");
    assert.equal(list.posts[0].evalScore, 55);
  });

  test("eval 점수 미달 → released 상태 전이 없음", async () => {
    await simulatePipelineRun("pipe-fail-002", 60);
    const state = await getApprovalState("pipe-fail-002");
    assert.equal(state.state, "audit_failed");
    // released 상태가 없어야 함
    const hasReleased = state.history.some(h => h.to === "released");
    assert.equal(hasReleased, false);
  });

  test("eval 점수 통과 → released, posting status=approved", async () => {
    const result = await simulatePipelineRun("pipe-pass-001", 85);
    assert.equal(result.stage, "complete");
    assert.equal(result.postStatus, "approved");
    assert.equal(result.approvalState, "released");
  });
});

describe("Phase 5 — approval state machine 전이 검증", () => {
  beforeEach(() => { store.clear(); });

  test("정상 전이 순서 전체", async () => {
    const pid = "pipe-sm-001";
    await initApprovalState({ pipelineId: pid, topicId: "t-1", userId: "u-1" });

    const steps = [
      { to: "waiting_for_user_approval", reason: "승인 요청" },
      { to: "approved_pending_record_update", reason: "승인" },
      { to: "records_updated", reason: "records 반영" },
      { to: "released", reason: "배포" },
    ];

    for (const step of steps) {
      const r = await transitionApprovalState({ pipelineId: pid, ...step });
      assert.equal(r.success, true, `전이 실패: → ${step.to}`);
    }

    const final = await getApprovalState(pid);
    assert.equal(final.state, "released");
    assert.equal(final.history.length, 5); // init + 4 transitions
  });

  test("released → 추가 전이 불가 (최종 상태)", async () => {
    const pid = "pipe-sm-released";
    await initApprovalState({ pipelineId: pid, topicId: "t", userId: "u" });
    const steps = ["waiting_for_user_approval", "approved_pending_record_update", "records_updated", "released"];
    for (const to of steps) await transitionApprovalState({ pipelineId: pid, to, reason: "test" });

    const r = await transitionApprovalState({ pipelineId: pid, to: "draft_ready", reason: "불가 테스트" });
    assert.equal(r.success, false);
    assert.ok(r.error?.includes("전이 불가"));
  });

  test("audit_failed → records_updated (관리자 복구)", async () => {
    const pid = "pipe-sm-recover";
    await initApprovalState({ pipelineId: pid, topicId: "t", userId: "u" });
    const steps = ["waiting_for_user_approval", "approved_pending_record_update", "records_updated", "audit_failed"];
    for (const to of steps) await transitionApprovalState({ pipelineId: pid, to, reason: "test" });

    const r = await transitionApprovalState({ pipelineId: pid, to: "records_updated", reason: "관리자 복구" });
    assert.equal(r.success, true);

    const s = await getApprovalState(pid);
    assert.equal(s.state, "records_updated");
  });

  test("audit_failed → released 직접 전이 불가", async () => {
    const pid = "pipe-sm-no-skip";
    await initApprovalState({ pipelineId: pid, topicId: "t", userId: "u" });
    const steps = ["waiting_for_user_approval", "approved_pending_record_update", "records_updated", "audit_failed"];
    for (const to of steps) await transitionApprovalState({ pipelineId: pid, to, reason: "test" });

    const r = await transitionApprovalState({ pipelineId: pid, to: "released", reason: "직접 시도" });
    assert.equal(r.success, false);
    assert.ok(r.error?.includes("전이 불가"));
  });

  test("force_approval_state — 허용 안된 전이도 강제 가능 (관리자 전용)", async () => {
    const pid = "pipe-sm-force";
    await initApprovalState({ pipelineId: pid, topicId: "t", userId: "u" });

    const r = await forceApprovalState({ pipelineId: pid, to: "released", reason: "비상 처리", actor: "admin" });
    assert.equal(r.success, true);

    const s = await getApprovalState(pid);
    assert.equal(s.state, "released");
    assert.ok(s.history[s.history.length - 1].reason.startsWith("[FORCE]"));
  });
});

describe("Phase 5 — operation logger", () => {
  beforeEach(() => { store.clear(); });

  test("gate_result 로그 수집", async () => {
    await appendLog("pipe-log-001", { type: "gate_result", gate: "post-audit", passed: false, blockedBy: "audit_not_approved", reason: "65점", evalScore: 65 });
    await appendLog("pipe-log-002", { type: "gate_result", gate: "post-audit", passed: true, blockedBy: null, reason: "82점", evalScore: 82 });

    const gateEntries = await getLogEntries({ type: "gate_result" });
    assert.equal(gateEntries.length, 2);
    assert.equal(gateEntries[0].passed, false);
    assert.equal(gateEntries[1].passed, true);
  });

  test("pipelineId 필터링", async () => {
    await appendLog("pipe-A", { type: "gate_result", gate: "pre-write", passed: true, blockedBy: null, reason: "ok" });
    await appendLog("pipe-B", { type: "gate_result", gate: "post-audit", passed: false, blockedBy: "audit_not_approved", reason: "낮음" });

    const forA = await getLogEntries({ pipelineId: "pipe-A" });
    assert.equal(forA.length, 1);
    assert.equal(forA[0].pipelineId, "pipe-A");
  });

  test("여러 타입 로그 혼재 — 타입 필터", async () => {
    await appendLog("pipe-C", { type: "corpus_retrieval", userId: "u-1", selectedCount: 4, strategy: "exemplar_index", staleCount: 0, staleWarnings: [], topScores: [] });
    await appendLog("pipe-C", { type: "gate_result", gate: "pre-write", passed: true, blockedBy: null, reason: "ok" });
    await appendLog("pipe-C", { type: "material_change", originalTitle: "카페 추천", proposedTitle: "카페 후기", isMaterial: true, triggeredSignals: ["searchIntentChanged", "coreKeywordChanged"], stringSimilarity: 0.4, overrideByHighSim: false });

    const corpus = await getLogEntries({ type: "corpus_retrieval" });
    const gates = await getLogEntries({ type: "gate_result" });
    const mc = await getLogEntries({ type: "material_change" });

    assert.equal(corpus.length, 1);
    assert.equal(gates.length, 1);
    assert.equal(mc.length, 1);
    assert.equal(mc[0].isMaterial, true);
  });

  test("gate_blocked 후 approval_ux 타임아웃 로그 수집", async () => {
    const pid = "pipe-timeout";
    await appendLog(pid, {
      type: "approval_ux",
      materialChange: true,
      requestedAt: new Date(Date.now() - 35 * 60 * 1000).toISOString(),
      respondedAt: null,
      approved: null,
      elapsedMs: null,
      timedOut: true,
    });

    const uxLogs = await getLogEntries({ type: "approval_ux" });
    assert.equal(uxLogs.length, 1);
    assert.equal(uxLogs[0].timedOut, true);
    assert.equal(uxLogs[0].approved, null);
  });
});

describe("Phase 5 — 관리자 복구 시나리오", () => {
  beforeEach(() => { store.clear(); });

  test("audit_failed → 관리자 복구 → released 정상 전이", async () => {
    const pid = "pipe-admin-recover";
    await initApprovalState({ pipelineId: pid, topicId: "t", userId: "u" });

    // 파이프라인 진행 → gate fail
    for (const to of ["waiting_for_user_approval", "approved_pending_record_update", "records_updated", "audit_failed"]) {
      await transitionApprovalState({ pipelineId: pid, to, reason: "test" });
    }

    // 관리자: records_updated로 복구
    const r1 = await transitionApprovalState({ pipelineId: pid, to: "records_updated", reason: "관리자 재평가 후 복구", actor: "admin" });
    assert.equal(r1.success, true);

    // 이후 released로 정상 전이
    const r2 = await transitionApprovalState({ pipelineId: pid, to: "released", reason: "수동 승인 후 배포", actor: "admin" });
    assert.equal(r2.success, true);

    const final = await getApprovalState(pid);
    assert.equal(final.state, "released");
    // history에 audit_failed → records_updated → released 순서 확인
    const states = final.history.map(h => h.to);
    assert.ok(states.indexOf("audit_failed") < states.indexOf("released"));
  });

  test("force_stop — draft_ready로 강제 복구", async () => {
    const pid = "pipe-force-stop";
    await initApprovalState({ pipelineId: pid, topicId: "t", userId: "u" });
    await transitionApprovalState({ pipelineId: pid, to: "waiting_for_user_approval", reason: "승인 대기 중" });

    // 관리자 강제 중단
    const r = await forceApprovalState({ pipelineId: pid, to: "draft_ready", reason: "운영자 강제 중단", actor: "admin" });
    assert.equal(r.success, true);

    const s = await getApprovalState(pid);
    assert.equal(s.state, "draft_ready");
    const lastHistory = s.history[s.history.length - 1];
    assert.ok(lastHistory.reason.includes("[FORCE]"));
    assert.equal(lastHistory.actor, "admin");
  });
});
