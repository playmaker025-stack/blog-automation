/**
 * Phase 4 E2E tests — GitHub mock 기반
 *
 * 시나리오:
 *   1. posting-list 읽기 / 쓰기
 *   2. index(topics) 읽기 / 상태 변경
 *   3. corpus retrieval (exemplar_index + 점수 계산)
 *   4. approval 후 posting-list 수정
 *   5. index 반영 (approval gate 통과 후)
 *   6. baseline compare (diff 계산)
 *   7. pre-write gate 차단 시나리오
 *   8. post-audit gate 차단 시나리오
 *   9. baseline candidate 등록 + 수동 승격
 *  10. corpus stale exemplar 경고
 *  11. corpus intent/role 가중치 반영
 */

import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";

// ============================================================
// In-memory GitHub store
// ============================================================

let store = new Map();

const gh = {
  async fileExists(path) { return store.has(path); },
  async readJsonFile(path) {
    if (!store.has(path)) throw new Error(`Not found: ${path}`);
    const e = store.get(path);
    return { data: e.data, sha: e.sha };
  },
  async writeJsonFile(path, data, _msg, _sha) {
    const sha = `sha-${Math.random().toString(36).slice(2, 9)}`;
    store.set(path, { data, sha });
    return sha;
  },
  async writeFile(path, content, _msg, _sha) {
    store.set(path, { data: content, sha: `sha-${Math.random().toString(36).slice(2, 9)}` });
  },
};

// ============================================================
// Helpers (inline domain logic — mirrors lib/agents/* pure functions)
// ============================================================

function now() { return new Date().toISOString(); }

// posting-list helpers
async function readPostingList() {
  const path = "data/posting-list/index.json";
  if (!(await gh.fileExists(path))) return { posts: [], lastUpdated: now() };
  const { data } = await gh.readJsonFile(path);
  return data;
}

async function writePostingList(list) {
  const path = "data/posting-list/index.json";
  const exists = await gh.fileExists(path);
  const sha = exists ? (await gh.readJsonFile(path)).sha : null;
  await gh.writeJsonFile(path, list, "update posting-list", sha);
}

// topics index helpers
async function readTopicsIndex() {
  const path = "data/index/topics.json";
  if (!(await gh.fileExists(path))) return { topics: [], lastUpdated: now() };
  const { data } = await gh.readJsonFile(path);
  return data;
}

async function writeTopicsIndex(index) {
  const path = "data/index/topics.json";
  const exists = await gh.fileExists(path);
  const sha = exists ? (await gh.readJsonFile(path)).sha : null;
  await gh.writeJsonFile(path, index, "update topics", sha);
}

// baseline helpers (mirrors baseline-manager.ts logic)
const REGRESSION_THRESHOLD = -5;
const PASS_THRESHOLD = 70;
const DETERMINISTIC = ["forbidden_check", "structure"];
const QUALITY = ["originality", "style_match", "engagement"];

function compareBaseline(scenarioId, current, baseline) {
  const deterministic = DETERMINISTIC.map(dim => {
    const b = baseline.scores[dim] ?? 0;
    const c = current.scores[dim] ?? 0;
    const delta = c - b;
    return { dimension: dim, baseline: b, current: c, delta, regression: delta <= REGRESSION_THRESHOLD };
  });
  const quality = QUALITY.map(dim => {
    const b = baseline.scores[dim] ?? 0;
    const c = current.scores[dim] ?? 0;
    return { dimension: dim, baseline: b, current: c, delta: c - b };
  });
  const aggregateDelta = current.aggregateScore - baseline.aggregateScore;
  const overallRegression = deterministic.some(d => d.regression) || aggregateDelta <= REGRESSION_THRESHOLD;
  return { scenarioId, deterministic, quality, aggregateDelta, overallRegression };
}

async function saveBaseline(scenarioId, record) {
  const path = `evals/baselines/${scenarioId}/latest.json`;
  const exists = await gh.fileExists(path);
  const sha = exists ? (await gh.readJsonFile(path)).sha : null;
  await gh.writeJsonFile(path, { ...record, savedAt: now() }, "save baseline", sha);
}

async function getBaseline(scenarioId) {
  const path = `evals/baselines/${scenarioId}/latest.json`;
  if (!(await gh.fileExists(path))) return null;
  const { data } = await gh.readJsonFile(path);
  return data;
}

async function registerCandidate(params) {
  if (params.aggregateScore < PASS_THRESHOLD) return { registered: false, reason: "점수 미달" };
  const path = `evals/baselines/${params.scenarioId}/candidates.json`;
  const exists = await gh.fileExists(path);
  const sha = exists ? (await gh.readJsonFile(path)).sha : null;
  const list = exists ? (await gh.readJsonFile(path)).data : [];
  const deduped = list.filter(c => c.runId !== params.runId);
  await gh.writeJsonFile(path, [...deduped, { ...params, recordedAt: now(), evalPassed: true }], "register candidate", sha);
  return { registered: true };
}

async function promoteToBaseline(scenarioId, runId, promotedBy) {
  const path = `evals/baselines/${scenarioId}/candidates.json`;
  if (!(await gh.fileExists(path))) return { success: false, reason: "candidate 없음" };
  const { data: list, sha } = await gh.readJsonFile(path);
  const target = list.find(c => c.runId === runId);
  if (!target) return { success: false, reason: "run 없음" };
  await saveBaseline(scenarioId, { ...target, promotedBy, promotedAt: now() });
  await gh.writeJsonFile(path, list.filter(c => c.runId !== runId), "remove promoted", sha);
  return { success: true };
}

// release gate helpers
function runPreWriteGate({ sourceReport, approvalRequest, recordUpdate }) {
  if (sourceReport?.groundingStatus === "insufficient_grounding")
    return { passed: false, blockedBy: "insufficient_grounding" };
  if (approvalRequest && approvalRequest.response.respondedAt === null)
    return { passed: false, blockedBy: "approval_missing" };
  if (approvalRequest && !approvalRequest.response.approved)
    return { passed: false, blockedBy: "approval_missing" };
  if (approvalRequest?.materialChange && !recordUpdate?.postingListUpdated)
    return { passed: false, blockedBy: "material_change_unsynced" };
  return { passed: true, blockedBy: null };
}

function runPostAuditGate({ auditReport, minScore = 70 }) {
  if (!auditReport) return { passed: true, blockedBy: null };
  if (!auditReport.pass || auditReport.aggregateScore < minScore)
    return { passed: false, blockedBy: "audit_not_approved" };
  return { passed: true, blockedBy: null };
}

// corpus scoring (mirrors corpus-selector.ts)
function recencyScore(publishedAt) {
  const ageDays = (Date.now() - new Date(publishedAt).getTime()) / (1000 * 60 * 60 * 24);
  return Math.pow(0.5, ageDays / 90);
}
function scoreExemplar(entry, context = {}) {
  const INTENT_PATTERNS = {
    "how-to": /방법|하는법|가이드/,
    "review": /후기|리뷰|직접|경험/,
    "list": /추천|순위|\d+가지/,
  };
  const ROLE_PATTERNS = {
    "personal-experience": /직접|경험|후기/,
    "tutorial": /방법|가이드|단계/,
    "ranking": /순위|베스트|\d+선/,
  };
  function classify(text, patterns) {
    const lower = text.toLowerCase();
    for (const [k, p] of Object.entries(patterns)) { if (p.test(lower)) return k; }
    return "unknown";
  }
  const entryText = `${entry.title} ${(entry.tags || []).join(" ")}`;
  const intentMatch = context.targetIntent && context.targetIntent !== "unknown"
    ? (classify(entryText, INTENT_PATTERNS) === context.targetIntent ? 1 : 0)
    : 0.5;
  const roleMatch = context.targetRole && context.targetRole !== "neutral"
    ? (classify(entryText, ROLE_PATTERNS) === context.targetRole ? 1 : 0)
    : 0.5;

  const relevance = entry.relevanceScore ?? 0.5;
  const recency = recencyScore(entry.publishedAt);
  return {
    finalScore: relevance * 0.40 + recency * 0.25 + roleMatch * 0.20 + intentMatch * 0.15,
    components: { relevance, recency, roleMatch, intentMatch },
    isStale: (Date.now() - new Date(entry.publishedAt).getTime()) / (1000 * 60 * 60 * 24) > 180,
  };
}

// ============================================================
// Fixtures
// ============================================================

const TOPIC = { topicId: "t-001", title: "서울 카페 추천 TOP 10", status: "pending", category: "라이프스타일", tags: ["카페", "서울"], createdAt: now(), updatedAt: now() };
const EXEMPLARS = [
  { sampleId: "e-001", title: "강남 카페 직접 후기", category: "라이프스타일", tags: ["카페", "강남"], relevanceScore: 0.9, styleNotes: "친근체", excerpt: "오늘은 제가 직접 다녀온...", wordCount: 1200, publishedAt: new Date(Date.now() - 30 * 86400e3).toISOString() },  // 30일 전
  { sampleId: "e-002", title: "서울 카페 추천 리스트", category: "라이프스타일", tags: ["카페", "추천"], relevanceScore: 0.85, styleNotes: "목록형", excerpt: "오늘은 추천 카페 정리해봤어요...", wordCount: 1000, publishedAt: new Date(Date.now() - 200 * 86400e3).toISOString() },  // 200일 전 (stale)
  { sampleId: "e-003", title: "홈카페 가이드 방법", category: "요리", tags: ["커피", "홈카페"], relevanceScore: 0.7, styleNotes: "튜토리얼", excerpt: "방법은 다음과 같아요...", wordCount: 900, publishedAt: new Date(Date.now() - 60 * 86400e3).toISOString() },  // 60일 전
];

// ============================================================
// 테스트
// ============================================================

describe("E2E — posting-list 읽기/쓰기", () => {
  beforeEach(() => { store.clear(); });

  test("빈 store에서 읽으면 빈 배열 반환", async () => {
    const list = await readPostingList();
    assert.deepEqual(list.posts, []);
  });

  test("posting record 추가 후 조회", async () => {
    const postId = "post-001";
    const list = await readPostingList();
    list.posts.push({ postId, topicId: "t-001", title: "테스트", status: "draft", createdAt: now(), updatedAt: now() });
    list.lastUpdated = now();
    await writePostingList(list);

    const loaded = await readPostingList();
    assert.equal(loaded.posts.length, 1);
    assert.equal(loaded.posts[0].postId, postId);
  });

  test("posting record 상태 업데이트", async () => {
    let list = await readPostingList();
    list.posts.push({ postId: "p-001", topicId: "t-001", title: "테스트", status: "draft", wordCount: 0, updatedAt: now() });
    await writePostingList(list);

    list = await readPostingList();
    const updated = { posts: list.posts.map(p => p.postId === "p-001" ? { ...p, status: "approved", wordCount: 1200, updatedAt: now() } : p), lastUpdated: now() };
    await writePostingList(updated);

    const final = await readPostingList();
    assert.equal(final.posts[0].status, "approved");
    assert.equal(final.posts[0].wordCount, 1200);
  });
});

describe("E2E — index(topics) 읽기/상태 변경", () => {
  beforeEach(() => { store.clear(); });

  test("topic index 저장 후 조회", async () => {
    await writeTopicsIndex({ topics: [TOPIC], lastUpdated: now() });
    const index = await readTopicsIndex();
    assert.equal(index.topics.length, 1);
    assert.equal(index.topics[0].topicId, "t-001");
  });

  test("topic status pending → in-progress → published", async () => {
    await writeTopicsIndex({ topics: [TOPIC], lastUpdated: now() });

    // in-progress
    let index = await readTopicsIndex();
    await writeTopicsIndex({ topics: index.topics.map(t => t.topicId === "t-001" ? { ...t, status: "in-progress" } : t), lastUpdated: now() });

    // published
    index = await readTopicsIndex();
    await writeTopicsIndex({ topics: index.topics.map(t => t.topicId === "t-001" ? { ...t, status: "published" } : t), lastUpdated: now() });

    const final = await readTopicsIndex();
    assert.equal(final.topics[0].status, "published");
  });
});

describe("E2E — corpus retrieval", () => {
  beforeEach(() => { store.clear(); });

  test("exemplar_index에서 점수 높은 순 정렬", async () => {
    const scored = EXEMPLARS.map(e => ({ ...scoreExemplar(e), sampleId: e.sampleId }));
    scored.sort((a, b) => b.finalScore - a.finalScore);
    // 점수 내림차순 확인
    for (let i = 0; i < scored.length - 1; i++) {
      assert.ok(scored[i].finalScore >= scored[i + 1].finalScore);
    }
  });

  test("stale exemplar (>180일) 감지", () => {
    const stale = EXEMPLARS.filter(e => scoreExemplar(e).isStale);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].sampleId, "e-002");
  });

  test("검색 의도(intent) 매칭 — 후기 의도 → review exemplar 우선", () => {
    const reviewExemplar = EXEMPLARS[0]; // "직접 후기" 포함
    const tutorialExemplar = EXEMPLARS[2]; // "방법" 포함

    const s1 = scoreExemplar(reviewExemplar, { targetIntent: "review" }).components.intentMatch;
    const s2 = scoreExemplar(tutorialExemplar, { targetIntent: "review" }).components.intentMatch;
    // review exemplar가 더 높은 intentMatch 점수
    assert.ok(s1 >= s2);
  });

  test("역할(role) 매칭 — tutorial 역할 → tutorial exemplar 우선", () => {
    const tutorialExemplar = EXEMPLARS[2]; // "방법/가이드" 포함
    const reviewExemplar = EXEMPLARS[0];   // "직접/경험" 포함

    const s1 = scoreExemplar(tutorialExemplar, { targetRole: "tutorial" }).components.roleMatch;
    const s2 = scoreExemplar(reviewExemplar, { targetRole: "tutorial" }).components.roleMatch;
    assert.ok(s1 >= s2);
  });

  test("최신성(recency) — 30일 > 60일 > 200일", () => {
    const r30 = recencyScore(EXEMPLARS[0].publishedAt);   // 30일
    const r60 = recencyScore(EXEMPLARS[2].publishedAt);   // 60일
    const r200 = recencyScore(EXEMPLARS[1].publishedAt);  // 200일
    assert.ok(r30 > r60);
    assert.ok(r60 > r200);
  });
});

describe("E2E — approval 후 posting-list + index 반영", () => {
  beforeEach(() => { store.clear(); });

  test("approval 없이 pre-write gate 차단", () => {
    const gate = runPreWriteGate({
      sourceReport: null,
      approvalRequest: { materialChange: false, response: { approved: false, respondedAt: null } },
      recordUpdate: null,
    });
    assert.equal(gate.passed, false);
    assert.equal(gate.blockedBy, "approval_missing");
  });

  test("approval 완료 후 posting-list 업데이트 + gate 통과", async () => {
    // setup
    await writePostingList({ posts: [], lastUpdated: now() });
    await writeTopicsIndex({ topics: [TOPIC], lastUpdated: now() });

    // 1. posting-list 업데이트
    let list = await readPostingList();
    const postId = "post-gate-001";
    list.posts.push({ postId, topicId: "t-001", title: "테스트", status: "draft", updatedAt: now() });
    await writePostingList({ ...list, lastUpdated: now() });

    // 2. record_update artifact
    const recordUpdate = { postingListUpdated: true, postingListUpdatedAt: now(), indexUpdated: false };

    // 3. approval 완료 artifact
    const approvalRequest = {
      materialChange: false,
      response: { approved: true, respondedAt: now(), modifications: null },
    };

    // pre-write gate
    const gate = runPreWriteGate({ sourceReport: null, approvalRequest, recordUpdate });
    assert.equal(gate.passed, true);

    // 4. index 업데이트
    const index = await readTopicsIndex();
    await writeTopicsIndex({
      topics: index.topics.map(t => t.topicId === "t-001" ? { ...t, status: "in-progress" } : t),
      lastUpdated: now(),
    });

    const finalIndex = await readTopicsIndex();
    assert.equal(finalIndex.topics[0].status, "in-progress");
  });

  test("material_change + posting-list 미업데이트 → gate 차단", () => {
    const gate = runPreWriteGate({
      sourceReport: null,
      approvalRequest: {
        materialChange: true,
        response: { approved: true, respondedAt: now() },
      },
      recordUpdate: { postingListUpdated: false },
    });
    assert.equal(gate.passed, false);
    assert.equal(gate.blockedBy, "material_change_unsynced");
  });
});

describe("E2E — baseline compare + candidate 관리", () => {
  beforeEach(() => { store.clear(); });

  test("baseline 저장 → 비교 → 회귀 없음", async () => {
    const scenarioId = "t-001";
    await saveBaseline(scenarioId, {
      runId: "base-001", scenarioId, postId: "p-base",
      promotedAt: now(), promotedBy: "admin",
      scores: { originality: 80, style_match: 85, structure: 75, engagement: 72, forbidden_check: 100 },
      aggregateScore: 82, notes: "초기 baseline",
    });

    const baseline = await getBaseline(scenarioId);
    assert.ok(baseline);
    assert.equal(baseline.aggregateScore, 82);

    const diff = compareBaseline(scenarioId,
      { runId: "run-002", scores: { originality: 83, style_match: 87, structure: 78, engagement: 74, forbidden_check: 100 }, aggregateScore: 85 },
      baseline
    );
    assert.equal(diff.overallRegression, false);
    assert.equal(diff.aggregateDelta, 3);
  });

  test("deterministic 차원 5점 이상 하락 → 회귀 감지", async () => {
    const scenarioId = "t-002";
    await saveBaseline(scenarioId, {
      runId: "base-002", scenarioId, postId: "p-base2",
      promotedAt: now(), promotedBy: "admin",
      scores: { originality: 80, style_match: 85, structure: 80, engagement: 70, forbidden_check: 100 },
      aggregateScore: 83, notes: "",
    });
    const baseline = await getBaseline(scenarioId);
    const diff = compareBaseline(scenarioId,
      { runId: "r-003", scores: { originality: 80, style_match: 85, structure: 70, engagement: 70, forbidden_check: 100 }, aggregateScore: 80 },
      baseline
    );
    const structureDim = diff.deterministic.find(d => d.dimension === "structure");
    assert.ok(structureDim.regression);
    assert.equal(diff.overallRegression, true);
  });

  test("candidate 등록 → 수동 승격 흐름", async () => {
    const scenarioId = "t-003";

    // 1. 파이프라인 완료 후 candidate 등록 (자동 baseline 저장 없음)
    const reg = await registerCandidate({
      scenarioId, runId: "run-promote-001", postId: "p-001",
      pipelineId: "pipe-001", scores: { originality: 85, style_match: 88, structure: 80, engagement: 75, forbidden_check: 100 },
      aggregateScore: 85, notes: "test",
    });
    assert.equal(reg.registered, true);

    // baseline은 아직 없어야 함
    const before = await getBaseline(scenarioId);
    assert.equal(before, null);

    // 2. 수동 승격
    const result = await promoteToBaseline(scenarioId, "run-promote-001", "admin");
    assert.equal(result.success, true);

    // baseline 이제 존재해야 함
    const after = await getBaseline(scenarioId);
    assert.ok(after);
    assert.equal(after.aggregateScore, 85);
    assert.equal(after.promotedBy, "admin");

    // candidate 목록에서 제거됐는지 확인
    const candidatesPath = `evals/baselines/${scenarioId}/candidates.json`;
    const { data: candidates } = await gh.readJsonFile(candidatesPath);
    assert.equal(candidates.length, 0);
  });

  test("eval 미통과 (< 70점) candidate 등록 거부", async () => {
    const reg = await registerCandidate({
      scenarioId: "t-004", runId: "run-low", postId: "p-low",
      pipelineId: "pipe-low",
      scores: { originality: 55, style_match: 60, structure: 50, engagement: 55, forbidden_check: 100 },
      aggregateScore: 60, notes: "",
    });
    assert.equal(reg.registered, false);
  });
});

describe("E2E — post-audit gate", () => {
  test("eval 통과 → post-audit gate 통과", () => {
    const gate = runPostAuditGate({ auditReport: { pass: true, aggregateScore: 85 } });
    assert.equal(gate.passed, true);
  });

  test("eval 미통과 → post-audit gate 차단", () => {
    const gate = runPostAuditGate({ auditReport: { pass: false, aggregateScore: 65 } });
    assert.equal(gate.passed, false);
    assert.equal(gate.blockedBy, "audit_not_approved");
  });

  test("auditReport 없음 → gate 통과 (skip)", () => {
    const gate = runPostAuditGate({ auditReport: null });
    assert.equal(gate.passed, true);
  });

  test("커스텀 minScore 적용", () => {
    const gate = runPostAuditGate({ auditReport: { pass: true, aggregateScore: 75 }, minScore: 80 });
    assert.equal(gate.passed, false);
  });
});
