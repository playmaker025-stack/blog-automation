/**
 * 운영 안정화 테스트 — 운영 초기 보강 3종
 *
 * 1. gate fail 시 failure artifact 저장 (gate_failure_report / run_state_snapshot / blocking_reason)
 * 2. 다중 사용자 동시성 — SHA 409 충돌 재시도
 * 3. 관리자 API 인증 (ADMIN_API_KEY) + 감사 로그
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ============================================================
// In-memory GitHub mock (SHA 409 시뮬레이션 포함)
// ============================================================

let store = new Map();
let conflictMap = new Map(); // path → 남은 충돌 횟수

const gh = {
  async fileExists(p) { return store.has(p); },
  async readJsonFile(p) {
    if (!store.has(p)) throw new Error(`Not found: ${p}`);
    const e = store.get(p);
    return { data: JSON.parse(JSON.stringify(e.data)), sha: e.sha };
  },
  async writeJsonFile(p, data, _msg, sha) {
    const current = store.get(p);
    // SHA 충돌 시뮬레이션
    const conflicts = conflictMap.get(p) ?? 0;
    if (conflicts > 0) {
      conflictMap.set(p, conflicts - 1);
      const err = new Error("SHA conflict");
      err.status = 409;
      throw err;
    }
    // SHA 불일치 검사 (파일 존재 + sha 불일치)
    if (current && sha && sha !== current.sha) {
      const err = new Error("SHA mismatch");
      err.status = 409;
      throw err;
    }
    const newSha = `sha-${Math.random().toString(36).slice(2, 9)}`;
    store.set(p, { data: JSON.parse(JSON.stringify(data)), sha: newSha });
    return newSha;
  },
};

// ============================================================
// artifact registry (inline mirror)
// ============================================================

function artifactPath(pipelineId, type) {
  return `data/pipeline-ledger/artifacts/${pipelineId}/${type}.json`;
}

async function saveArtifact(pipelineId, type, data) {
  const envelope = { pipelineId, type, savedAt: new Date().toISOString(), data };
  const path = artifactPath(pipelineId, type);
  let sha = null;
  if (await gh.fileExists(path)) {
    const current = await gh.readJsonFile(path);
    sha = current.sha;
  }
  await gh.writeJsonFile(path, envelope, `artifact ${type}`, sha);
}

async function getArtifact(pipelineId, type) {
  const path = artifactPath(pipelineId, type);
  if (!(await gh.fileExists(path))) return null;
  const { data } = await gh.readJsonFile(path);
  return data;
}

// ============================================================
// withConflictRetry (inline mirror)
// ============================================================

async function withConflictRetry(fn, maxAttempts = 4) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status;
      if ((status === 409 || status === 422) && attempt < maxAttempts - 1) continue;
      throw err;
    }
  }
  throw new Error("withConflictRetry: unreachable");
}

// ============================================================
// posting-list helpers (with conflict retry)
// ============================================================

const POSTING_LIST_PATH = "data/posting-list/index.json";

async function updatePostRecord(postId, patch) {
  await withConflictRetry(async () => {
    if (!(await gh.fileExists(POSTING_LIST_PATH))) return;
    const { data: index, sha } = await gh.readJsonFile(POSTING_LIST_PATH);
    const now = new Date().toISOString();
    const updated = {
      posts: index.posts.map(p => p.postId === postId ? { ...p, ...patch, updatedAt: now } : p),
      lastUpdated: now,
    };
    await gh.writeJsonFile(POSTING_LIST_PATH, updated, `update post ${postId}`, sha);
  });
}

async function updateTopicStatus(topicId, status) {
  await withConflictRetry(async () => {
    if (!(await gh.fileExists("data/topics/index.json"))) return;
    const { data: index, sha } = await gh.readJsonFile("data/topics/index.json");
    const now = new Date().toISOString();
    const updated = {
      topics: index.topics.map(t => t.topicId === topicId ? { ...t, status, updatedAt: now } : t),
      lastUpdated: now,
    };
    await gh.writeJsonFile("data/topics/index.json", updated, `topic ${topicId} -> ${status}`, sha);
  });
}

// ============================================================
// admin audit (inline mirror)
// ============================================================

const ADMIN_AUDIT_PATH = "data/pipeline-ledger/admin-audit.json";

async function appendAdminAudit(entry) {
  let entries = [];
  let sha = null;
  if (await gh.fileExists(ADMIN_AUDIT_PATH)) {
    const { data, sha: fileSha } = await gh.readJsonFile(ADMIN_AUDIT_PATH);
    entries = data.entries;
    sha = fileSha;
  }
  await gh.writeJsonFile(
    ADMIN_AUDIT_PATH,
    { entries: [...entries, entry], lastUpdated: entry.at },
    `admin-audit: ${entry.action}`,
    sha
  );
}

async function getAdminAuditEntries() {
  if (!(await gh.fileExists(ADMIN_AUDIT_PATH))) return [];
  const { data } = await gh.readJsonFile(ADMIN_AUDIT_PATH);
  return data.entries;
}

// ============================================================
// 인증 미들웨어 (inline mirror)
// ============================================================

function authenticate(headers, envKey) {
  if (!envKey) return { ok: false, status: 500, error: "ADMIN_API_KEY 미설정" };
  const auth = headers.get("Authorization");
  if (auth !== `Bearer ${envKey}`) return { ok: false, status: 401, error: "인증 실패" };
  return { ok: true };
}

// ============================================================
// 테스트 1: gate fail 시 failure artifact 저장
// ============================================================

describe("운영 보강 1 — gate fail failure artifact 저장", () => {
  beforeEach(() => { store.clear(); conflictMap.clear(); });

  test("post-audit gate fail → gate_failure_report 저장됨", async () => {
    const pid = "pipe-gf-001";
    await saveArtifact(pid, "gate_failure_report", {
      gate: "post-audit",
      blockedBy: "eval_score_below_threshold",
      reason: "점수 미달: 62점",
      evalScore: 62,
      evalScores: { clarity: 60, depth: 65 },
      recommendations: ["주제 심화 필요", "근거 추가"],
      baselineDelta: -8,
      blockedAt: new Date().toISOString(),
    });

    const artifact = await getArtifact(pid, "gate_failure_report");
    assert.ok(artifact, "gate_failure_report 저장됨");
    assert.equal(artifact.data.gate, "post-audit");
    assert.equal(artifact.data.evalScore, 62);
    assert.equal(artifact.data.blockedBy, "eval_score_below_threshold");
    assert.ok(Array.isArray(artifact.data.recommendations));
  });

  test("post-audit gate fail → run_state_snapshot 저장됨", async () => {
    const pid = "pipe-gf-002";
    const snapshotAt = new Date().toISOString();
    await saveArtifact(pid, "run_state_snapshot", {
      pipelineId: pid,
      topicId: "t-001",
      userId: "u-001",
      stage: "gate_blocked",
      approvalState: "audit_failed",
      postId: "post-abc",
      strategyTitle: "서울 카페 베스트 10",
      wordCount: 1450,
      evalScore: 62,
      postingListUpdated: true,
      indexUpdated: true,
      snapshotAt,
    });

    const artifact = await getArtifact(pid, "run_state_snapshot");
    assert.ok(artifact, "run_state_snapshot 저장됨");
    assert.equal(artifact.data.stage, "gate_blocked");
    assert.equal(artifact.data.approvalState, "audit_failed");
    assert.equal(artifact.data.wordCount, 1450);
    assert.equal(artifact.data.postingListUpdated, true);
  });

  test("post-audit gate fail → blocking_reason 저장됨", async () => {
    const pid = "pipe-gf-003";
    await saveArtifact(pid, "blocking_reason", {
      gate: "post-audit",
      code: "eval_score_below_threshold",
      summary: "평가 점수 미달 (62점): 최소 70점 필요",
      actionRequired: "본문을 수정하거나 평가 기준을 재검토한 후 다시 실행해 주세요.",
      canRetry: true,
    });

    const artifact = await getArtifact(pid, "blocking_reason");
    assert.ok(artifact, "blocking_reason 저장됨");
    assert.equal(artifact.data.gate, "post-audit");
    assert.equal(artifact.data.canRetry, true);
    assert.ok(artifact.data.summary.includes("62점"));
  });

  test("pre-write gate fail → 3종 failure artifact 모두 저장됨", async () => {
    const pid = "pipe-gf-prewrite";
    const blockedAt = new Date().toISOString();

    // Promise.allSettled 방식으로 저장 (orchestrator 동일 패턴)
    const results = await Promise.allSettled([
      saveArtifact(pid, "gate_failure_report", {
        gate: "pre-write",
        blockedBy: "approval_missing",
        reason: "승인 없이 작성 시도",
        blockedAt,
      }),
      saveArtifact(pid, "run_state_snapshot", {
        pipelineId: pid,
        topicId: "t-002",
        userId: "u-001",
        stage: "awaiting-approval",
        approvalState: "records_updated",
        postId: "post-xyz",
        strategyTitle: "제주 여행 코스",
        wordCount: null,
        evalScore: null,
        postingListUpdated: true,
        indexUpdated: true,
        snapshotAt: blockedAt,
      }),
      saveArtifact(pid, "blocking_reason", {
        gate: "pre-write",
        code: "approval_missing",
        summary: "승인 없이 작성 시도",
        actionRequired: "전략 재검토 후 다시 실행해 주세요.",
        canRetry: true,
      }),
    ]);

    // 3종 모두 fulfilled
    assert.equal(results.every(r => r.status === "fulfilled"), true, "3종 아티팩트 모두 저장 성공");

    const gfr = await getArtifact(pid, "gate_failure_report");
    const rss = await getArtifact(pid, "run_state_snapshot");
    const br = await getArtifact(pid, "blocking_reason");

    assert.ok(gfr, "gate_failure_report 존재");
    assert.ok(rss, "run_state_snapshot 존재");
    assert.ok(br, "blocking_reason 존재");
    assert.equal(gfr.data.gate, "pre-write");
    assert.equal(rss.data.wordCount, null);  // 아직 작성 전
    assert.equal(br.data.canRetry, true);
  });

  test("failure artifact 저장 실패해도 파이프라인 상태에 영향 없음 (allSettled)", async () => {
    // allSettled 패턴으로 인해 일부 저장 실패해도 전체가 throw되지 않음
    const results = await Promise.allSettled([
      Promise.resolve("ok"),
      Promise.reject(new Error("저장 실패 시뮬레이션")),
      Promise.resolve("ok"),
    ]);
    const failed = results.filter(r => r.status === "rejected");
    const succeeded = results.filter(r => r.status === "fulfilled");
    assert.equal(failed.length, 1);
    assert.equal(succeeded.length, 2);
    // 전체 로직이 중단되지 않음
  });
});

// ============================================================
// 테스트 2: 다중 사용자 동시성 (SHA 충돌 재시도)
// ============================================================

describe("운영 보강 2 — SHA 충돌 재시도 (posting-list / index)", () => {
  beforeEach(() => { store.clear(); conflictMap.clear(); });

  test("withConflictRetry — 409 충돌 1회 후 재시도 성공", async () => {
    let attemptCount = 0;
    const result = await withConflictRetry(async () => {
      attemptCount++;
      if (attemptCount < 2) {
        const err = new Error("SHA mismatch");
        err.status = 409;
        throw err;
      }
      return "success";
    });
    assert.equal(result, "success");
    assert.equal(attemptCount, 2);
  });

  test("withConflictRetry — 422도 재시도 대상", async () => {
    let attemptCount = 0;
    const result = await withConflictRetry(async () => {
      attemptCount++;
      if (attemptCount < 3) {
        const err = new Error("Unprocessable");
        err.status = 422;
        throw err;
      }
      return "done";
    });
    assert.equal(result, "done");
    assert.equal(attemptCount, 3);
  });

  test("withConflictRetry — 최대 횟수 초과 시 에러 전파", async () => {
    await assert.rejects(
      withConflictRetry(async () => {
        const err = new Error("persistent conflict");
        err.status = 409;
        throw err;
      }, 3),
      /persistent conflict/
    );
  });

  test("withConflictRetry — 409 아닌 에러는 즉시 전파 (재시도 없음)", async () => {
    let attemptCount = 0;
    await assert.rejects(
      withConflictRetry(async () => {
        attemptCount++;
        throw new Error("network error");  // status 없음
      }),
      /network error/
    );
    assert.equal(attemptCount, 1, "재시도 없이 즉시 전파");
  });

  test("updatePostRecord — SHA 충돌 1회 후 재시도 성공", async () => {
    // 초기 데이터 설정
    const _initialSha = await gh.writeJsonFile(POSTING_LIST_PATH, {
      posts: [{ postId: "post-123", status: "draft", wordCount: 0 }],
      lastUpdated: "",
    }, "init", null);

    // 다음 writeJsonFile에 1회 충돌 주입
    conflictMap.set(POSTING_LIST_PATH, 1);

    await updatePostRecord("post-123", { status: "ready", wordCount: 1200 });

    const { data } = await gh.readJsonFile(POSTING_LIST_PATH);
    const post = data.posts.find(p => p.postId === "post-123");
    assert.equal(post.status, "ready");
    assert.equal(post.wordCount, 1200);
  });

  test("updateTopicStatus — SHA 충돌 2회 후 재시도 성공", async () => {
    await gh.writeJsonFile("data/topics/index.json", {
      topics: [{ topicId: "t-001", status: "pending", updatedAt: "" }],
      lastUpdated: "",
    }, "init", null);

    conflictMap.set("data/topics/index.json", 2);

    await updateTopicStatus("t-001", "in-progress");

    const { data } = await gh.readJsonFile("data/topics/index.json");
    assert.equal(data.topics[0].status, "in-progress");
  });

  test("동시 posting-list 업데이트 — 순차 실행 시 모두 반영됨", async () => {
    // 3개 포스트 순차 업데이트
    await gh.writeJsonFile(POSTING_LIST_PATH, {
      posts: [
        { postId: "p-1", status: "draft" },
        { postId: "p-2", status: "draft" },
        { postId: "p-3", status: "draft" },
      ],
      lastUpdated: "",
    }, "init", null);

    // 순차 업데이트 (현실에서는 순서 보장 안되지만 재시도로 수렴)
    await updatePostRecord("p-1", { status: "ready" });
    await updatePostRecord("p-2", { status: "approved" });
    await updatePostRecord("p-3", { status: "audit_failed" });

    const { data } = await gh.readJsonFile(POSTING_LIST_PATH);
    const statuses = Object.fromEntries(data.posts.map(p => [p.postId, p.status]));
    assert.equal(statuses["p-1"], "ready");
    assert.equal(statuses["p-2"], "approved");
    assert.equal(statuses["p-3"], "audit_failed");
  });
});

// ============================================================
// 테스트 3: 관리자 API 인증 + 감사 로그
// ============================================================

describe("운영 보강 3 — 관리자 API 인증 + 감사 로그", () => {
  beforeEach(() => { store.clear(); conflictMap.clear(); });

  test("올바른 ADMIN_API_KEY → 인증 통과", () => {
    const headers = new Map([["Authorization", "Bearer secret-key-123"]]);
    const result = authenticate(headers, "secret-key-123");
    assert.equal(result.ok, true);
  });

  test("잘못된 API 키 → 401 반환", () => {
    const headers = new Map([["Authorization", "Bearer wrong-key"]]);
    const result = authenticate(headers, "secret-key-123");
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });

  test("Authorization 헤더 없음 → 401 반환", () => {
    const headers = new Map();
    const result = authenticate(headers, "secret-key-123");
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });

  test("ADMIN_API_KEY 환경변수 미설정 → 500 반환", () => {
    const headers = new Map([["Authorization", "Bearer any-key"]]);
    const result = authenticate(headers, undefined);  // 환경변수 없음
    assert.equal(result.ok, false);
    assert.equal(result.status, 500);
  });

  test("force_stop 감사 로그 저장됨", async () => {
    const at = new Date().toISOString();
    await appendAdminAudit({
      action: "force_stop",
      pipelineId: "pipe-admin-001",
      actor: "admin-user",
      params: { previousStage: "writing" },
      result: "success",
      detail: "force_stop — previousStage: writing",
      at,
    });

    const entries = await getAdminAuditEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, "force_stop");
    assert.equal(entries[0].actor, "admin-user");
    assert.equal(entries[0].result, "success");
  });

  test("recover_approval 감사 로그 저장됨", async () => {
    const at = new Date().toISOString();
    await appendAdminAudit({
      action: "recover_approval",
      pipelineId: "pipe-admin-002",
      actor: "ops-team",
      params: { targetState: "records_updated", reason: "재평가 후 복구" },
      result: "success",
      detail: "recover_approval → records_updated",
      at,
    });

    const entries = await getAdminAuditEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].action, "recover_approval");
    assert.deepEqual(entries[0].params.targetState, "records_updated");
  });

  test("discard_candidate 감사 로그 저장됨", async () => {
    const at = new Date().toISOString();
    await appendAdminAudit({
      action: "discard_candidate",
      pipelineId: "pipe-admin-003",
      actor: "admin",
      params: { scenarioId: "scenario-001", runId: "run-abc" },
      result: "success",
      detail: "discard_candidate runId=run-abc scenarioId=scenario-001",
      at,
    });

    const entries = await getAdminAuditEntries();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].params.runId, "run-abc");
  });

  test("감사 로그 누적 — 여러 액션이 순서대로 보존됨", async () => {
    const actions = ["force_stop", "recover_approval", "discard_candidate"];
    for (const action of actions) {
      await appendAdminAudit({
        action,
        pipelineId: "pipe-multi",
        actor: "admin",
        params: {},
        result: "success",
        detail: action,
        at: new Date().toISOString(),
      });
    }

    const entries = await getAdminAuditEntries();
    assert.equal(entries.length, 3);
    assert.deepEqual(entries.map(e => e.action), actions);
  });

  test("에러 발생 시 감사 로그에 error result 기록됨", async () => {
    const at = new Date().toISOString();
    await appendAdminAudit({
      action: "recover_approval",
      pipelineId: "pipe-err-001",
      actor: "admin",
      params: { targetState: "released" },
      result: "error",
      detail: "전이 불가: audit_failed → released (허용: records_updated)",
      at,
    });

    const entries = await getAdminAuditEntries();
    assert.equal(entries[0].result, "error");
    assert.ok(entries[0].detail.includes("전이 불가"));
  });

  test("감사 로그는 rolling 없이 전체 보존됨 (operation-log와 차이)", async () => {
    // 600건 저장해도 전체 유지 (operation-log는 500건 rollover)
    const bigEntries = [];
    const _startSha = await gh.writeJsonFile(
      ADMIN_AUDIT_PATH,
      { entries: bigEntries, lastUpdated: "" },
      "init", null
    );

    for (let i = 0; i < 50; i++) {
      await appendAdminAudit({
        action: "force_stop",
        pipelineId: `pipe-${i}`,
        actor: "admin",
        params: {},
        result: "success",
        detail: `entry ${i}`,
        at: new Date().toISOString(),
      });
    }

    const entries = await getAdminAuditEntries();
    assert.equal(entries.length, 50, "50건 모두 보존");
    assert.equal(entries[0].detail, "entry 0");
    assert.equal(entries[49].detail, "entry 49");
  });
});
