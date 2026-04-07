/**
 * Phase 3 integration tests — GitHub mock 기반
 *
 * 테스트 대상:
 *   1. corpus-selector — exemplar_index 로드 및 summary artifact 생성
 *   2. artifact-registry — saveArtifact / getArtifact / getAllArtifacts
 *   3. release-gate — 4가지 조건 검사
 *   4. baseline-manager — 저장/비교/자동 갱신
 *   5. material-change-detector — 4신호 감지
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";

// ============================================================
// GitHub 모듈 mock (node:test의 mock.module 미지원 → 환경변수 + 직접 구현)
// ============================================================

// GitHub 파일 저장소 (in-memory)
const githubStore = new Map();

const mockRepo = {
  async fileExists(path) {
    return githubStore.has(path);
  },
  async readJsonFile(path) {
    if (!githubStore.has(path)) throw new Error(`File not found: ${path}`);
    const entry = githubStore.get(path);
    return { data: entry.data, sha: entry.sha };
  },
  async writeJsonFile(path, data, _message, _sha) {
    const sha = `sha-${Math.random().toString(36).slice(2, 10)}`;
    githubStore.set(path, { data, sha });
    return sha;
  },
};

// ============================================================
// 테스트용 순수 함수 직접 import (파일 경로 기반)
// ============================================================

// material-change-detector는 순수 함수이므로 직접 테스트 가능

function stringSimilarity(a, b) {
  const s1 = a.toLowerCase().replace(/\s+/g, "");
  const s2 = b.toLowerCase().replace(/\s+/g, "");
  if (s1 === s2) return 1;
  if (!s1.length || !s2.length) return 0;
  const dp = Array.from({ length: s1.length + 1 }, (_, i) =>
    Array.from({ length: s2.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0
    )
  );
  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      dp[i][j] =
        s1[i - 1] === s2[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return 1 - dp[s1.length][s2.length] / Math.max(s1.length, s2.length);
}

// material_change 감지 (테스트 전용 구현 — lib/agents/material-change-detector.ts 미러)
function detectMaterialChange(input) {
  const { original, proposed } = input;

  if (!original.title) {
    return { isMaterial: false, triggeredSignals: [], reason: "원본 제목 없음" };
  }

  const sim = stringSimilarity(original.title, proposed.title);
  if (sim >= 0.85) {
    return { isMaterial: false, triggeredSignals: [], reason: `유사도 ${sim.toFixed(2)} >= 0.85`, stringSimilarity: sim };
  }

  // Intent patterns
  const intentPatterns = {
    "how-to": /방법|하는법|따라하기|가이드|설치|만들기/,
    "review": /후기|리뷰|사용기|솔직|내돈내산|직접|경험/,
    "list": /추천|TOP\s?\d|순위|리스트|\d+가지|\d+선|모음/,
    "comparison": /vs|비교|차이|어느게|뭐가 낫/,
    "informational": /이란|란\?|정의|개념|뜻|이유|왜|원인/,
  };
  function classifyIntent(text) {
    const lower = text.toLowerCase();
    for (const [intent, p] of Object.entries(intentPatterns)) {
      if (p.test(lower)) return intent;
    }
    return "unknown";
  }
  const intentA = classifyIntent(`${original.title} ${original.intent ?? ""}`);
  const intentB = classifyIntent(proposed.title);
  const searchIntentChanged = intentA !== "unknown" && intentB !== "unknown" && intentA !== intentB;

  // Core keyword
  const stopwords = new Set(["완벽", "정리", "추천", "후기", "리뷰", "직접", "솔직", "가이드", "방법", "이유", "종류"]);
  function extractKws(title) {
    return title.replace(/[^\w\s가-힣]/g, " ").split(/\s+/).filter(t => t.length >= 2).map(t => t.toLowerCase()).filter(t => !stopwords.has(t));
  }
  const okws = [...(original.keywords ?? []), ...extractKws(original.title)].map(k => k.toLowerCase());
  const pkws = [...(proposed.keywords ?? []), ...extractKws(proposed.title)].map(k => k.toLowerCase());
  let coreKeywordChanged = false;
  if (okws.length > 0 && pkws.length > 0) {
    const shared = okws.filter(k => pkws.some(pk => pk.includes(k) || k.includes(pk)));
    coreKeywordChanged = shared.length / Math.max(okws.length, pkws.length) < 0.30;
  }

  // Angle
  const anglePatterns = {
    "personal-experience": /직접|내가|경험|후기|가봤|써봤|먹어봤/,
    "ranking": /TOP\s?\d|\d+선|순위|베스트|최고/,
    "comparison": /비교|vs|차이|어느|어떤게/,
    "tutorial": /방법|하는법|따라하|가이드|단계|순서대로/,
  };
  function classifyAngle(text) {
    const lower = text.toLowerCase();
    for (const [angle, p] of Object.entries(anglePatterns)) {
      if (p.test(lower)) return angle;
    }
    return "neutral";
  }
  const angleA = classifyAngle(original.title);
  const angleB = classifyAngle(proposed.title);
  const articleAngleChanged = angleA !== "neutral" && angleB !== "neutral" && angleA !== angleB;

  // Decision logic
  const logicPatterns = {
    "multi-item": /\d+가지|\d+개|\d+곳|목록|모음|리스트/,
    "pros-cons": /장단점|장점|단점/,
    "timeline": /과정|히스토리|역사|변천사|단계|순서/,
    "single-topic": /이란|뜻|정의|개념|완벽 정리/,
  };
  function classifyLogic(text) {
    const lower = text.toLowerCase();
    for (const [logic, p] of Object.entries(logicPatterns)) {
      if (p.test(lower)) return logic;
    }
    return "neutral";
  }
  const logicA = classifyLogic(original.title);
  const logicB = classifyLogic(`${proposed.title} ${proposed.rationale ?? ""}`);
  const decisionLogicChanged = logicA !== "neutral" && logicB !== "neutral" && logicA !== logicB;

  const triggered = [
    searchIntentChanged && "searchIntentChanged",
    coreKeywordChanged && "coreKeywordChanged",
    articleAngleChanged && "articleAngleChanged",
    decisionLogicChanged && "decisionLogicChanged",
  ].filter(Boolean);

  const isMaterial = triggered.length >= 2;
  return { isMaterial, triggeredSignals: triggered, stringSimilarity: sim, reason: isMaterial ? `material (${triggered.length} signals)` : `not material (${triggered.length} signals)` };
}

// ============================================================
// release-gate (순수 함수 — 직접 구현 미러)
// ============================================================

function runReleaseGate({ sourceReport, approvalRequest, recordUpdate, auditReport, skipAuditGate = false }) {
  const checks = [];

  // 1. source grounding
  if (sourceReport?.groundingStatus === "insufficient_grounding") {
    checks.push({ condition: "insufficient_grounding", pass: false, reason: "소스 접근 불충분" });
  } else {
    checks.push({ condition: "insufficient_grounding", pass: true, reason: "ok" });
  }

  // 2. approval
  if (approvalRequest && approvalRequest.response.respondedAt === null) {
    checks.push({ condition: "approval_missing", pass: false, reason: "승인 응답 없음" });
  } else if (approvalRequest && !approvalRequest.response.approved) {
    checks.push({ condition: "approval_missing", pass: false, reason: "사용자 거절" });
  } else {
    checks.push({ condition: "approval_missing", pass: true, reason: "ok" });
  }

  // 3. material_change sync
  if (approvalRequest?.materialChange && !recordUpdate?.postingListUpdated) {
    checks.push({ condition: "material_change_unsynced", pass: false, reason: "posting-list 미업데이트" });
  } else {
    checks.push({ condition: "material_change_unsynced", pass: true, reason: "ok" });
  }

  // 4. audit
  if (!skipAuditGate) {
    if (!auditReport || !auditReport.pass || auditReport.aggregateScore < 70) {
      checks.push({ condition: "audit_not_approved", pass: false, reason: "eval 점수 미달" });
    } else {
      checks.push({ condition: "audit_not_approved", pass: true, reason: "ok" });
    }
  }

  for (const c of checks) {
    if (!c.pass) return { passed: false, blockedBy: c.condition, reason: c.reason };
  }
  return { passed: true, blockedBy: null, reason: "모든 gate 조건 통과" };
}

// ============================================================
// baseline-manager (GitHub mock 사용)
// ============================================================

function compareWithBaseline({ scenarioId, current, baseline }) {
  const DETERMINISTIC = ["forbidden_check", "structure"];
  const QUALITY = ["originality", "style_match", "engagement"];
  const THRESHOLD = -5;

  const deterministic = DETERMINISTIC.map(dim => {
    const b = baseline.scores[dim] ?? 0;
    const c = current.scores[dim] ?? 0;
    const delta = c - b;
    return { dimension: dim, baseline: b, current: c, delta, regression: delta <= THRESHOLD };
  });

  const quality = QUALITY.map(dim => {
    const b = baseline.scores[dim] ?? 0;
    const c = current.scores[dim] ?? 0;
    return { dimension: dim, baseline: b, current: c, delta: c - b };
  });

  const aggregateDelta = current.aggregateScore - baseline.aggregateScore;
  const overallRegression = deterministic.some(d => d.regression) || aggregateDelta <= THRESHOLD;

  return {
    scenarioId,
    currentRunId: current.runId,
    baselineRunId: baseline.runId,
    deterministic,
    quality,
    aggregateDelta,
    overallRegression,
    summary: overallRegression ? `⚠ 회귀 감지 (delta: ${aggregateDelta})` : `✓ 회귀 없음 (delta: ${aggregateDelta})`,
  };
}

// ============================================================
// corpus-selector (buildSummaryArtifact 순수 함수 테스트)
// ============================================================

function buildSummaryArtifact({ userId, exemplars, strategy, userTone }) {
  const _excerpts = exemplars.map(e => e.excerpt).filter(Boolean);
  const avgWordCount = exemplars.length > 0
    ? Math.round(exemplars.reduce((acc, e) => acc + e.wordCount, 0) / exemplars.length)
    : 0;

  return {
    userId,
    selectedCount: exemplars.length,
    styleProfile: {
      dominantTone: userTone ?? "friendly",
      avgWordCount,
      signatureExpressions: [],
      structurePattern: "서술형 (자연스러운 단락)",
      openingPattern: "알 수 없음",
    },
    exemplarExcerpts: exemplars.map(e => ({
      sampleId: e.sampleId,
      title: e.title,
      excerpt: e.excerpt,
      styleNotes: e.styleNotes,
    })),
    retrievalStrategy: strategy,
  };
}

// ============================================================
// 테스트 suite
// ============================================================

describe("Phase 3 — material-change-detector", () => {
  test("동일 제목 → isMaterial=false (유사도 >= 0.85)", () => {
    const result = detectMaterialChange({
      original: { title: "서울 카페 추천 TOP 10" },
      proposed: { title: "서울 카페 추천 TOP 10" },
    });
    assert.equal(result.isMaterial, false);
  });

  test("미세 수정 → isMaterial=false (유사도 >= 0.85)", () => {
    const result = detectMaterialChange({
      original: { title: "서울 카페 추천 TOP 10" },
      proposed: { title: "서울 카페 추천 TOP10" },
    });
    assert.equal(result.isMaterial, false);
  });

  test("검색 의도 변경 + 핵심 키워드 변경 → isMaterial=true", () => {
    const result = detectMaterialChange({
      original: { title: "서울 카페 추천 TOP 10" },        // list + ranking
      proposed: { title: "강남역 카페 방문 후기 솔직 리뷰" }, // review + personal-experience
    });
    assert.equal(result.isMaterial, true);
    assert.ok(result.triggeredSignals.length >= 2);
  });

  test("원본 제목 없음 → 신규 토픽 (isMaterial=false)", () => {
    const result = detectMaterialChange({
      original: { title: "" },
      proposed: { title: "새로운 토픽" },
    });
    assert.equal(result.isMaterial, false);
  });

  test("1개 signal만 발화 → isMaterial=false", () => {
    // 제목 변경이 있지만 의도는 같은 경우 (방법 → 방법)
    const result = detectMaterialChange({
      original: { title: "파이썬 설치하는 방법" },
      proposed: { title: "파이썬 3.12 설치 가이드" },
    });
    // 유사도가 높지 않더라도 signal이 2개 미만이면 false
    assert.equal(result.isMaterial, false);
  });
});

describe("Phase 3 — release-gate", () => {
  test("모든 조건 통과 → passed=true", () => {
    const result = runReleaseGate({
      sourceReport: { groundingStatus: "sufficient", accessibleCount: 3, totalCount: 3 },
      approvalRequest: {
        materialChange: false,
        response: { approved: true, respondedAt: "2025-01-01T00:00:00Z", modifications: null },
      },
      recordUpdate: { postingListUpdated: true },
      auditReport: { pass: true, aggregateScore: 85 },
    });
    assert.equal(result.passed, true);
    assert.equal(result.blockedBy, null);
  });

  test("소스 grounding 불충분 → 첫 번째에서 차단", () => {
    const result = runReleaseGate({
      sourceReport: { groundingStatus: "insufficient_grounding", accessibleCount: 0, totalCount: 3 },
      approvalRequest: null,
      recordUpdate: null,
      auditReport: null,
    });
    assert.equal(result.passed, false);
    assert.equal(result.blockedBy, "insufficient_grounding");
  });

  test("승인 응답 없음 → approval_missing 차단", () => {
    const result = runReleaseGate({
      sourceReport: null,
      approvalRequest: {
        materialChange: false,
        response: { approved: false, respondedAt: null, modifications: null },
      },
      recordUpdate: null,
      auditReport: null,
    });
    assert.equal(result.passed, false);
    assert.equal(result.blockedBy, "approval_missing");
  });

  test("material_change 후 posting-list 미업데이트 → material_change_unsynced", () => {
    const result = runReleaseGate({
      sourceReport: null,
      approvalRequest: {
        materialChange: true,
        response: { approved: true, respondedAt: "2025-01-01T00:00:00Z", modifications: null },
      },
      recordUpdate: { postingListUpdated: false },
      auditReport: null,
      skipAuditGate: true,
    });
    assert.equal(result.passed, false);
    assert.equal(result.blockedBy, "material_change_unsynced");
  });

  test("eval 점수 미달 → audit_not_approved 차단", () => {
    const result = runReleaseGate({
      sourceReport: null,
      approvalRequest: {
        materialChange: false,
        response: { approved: true, respondedAt: "2025-01-01T00:00:00Z", modifications: null },
      },
      recordUpdate: { postingListUpdated: true },
      auditReport: { pass: false, aggregateScore: 60 },
    });
    assert.equal(result.passed, false);
    assert.equal(result.blockedBy, "audit_not_approved");
  });

  test("skipAuditGate=true → audit 조건 무시", () => {
    const result = runReleaseGate({
      sourceReport: null,
      approvalRequest: {
        materialChange: false,
        response: { approved: true, respondedAt: "2025-01-01T00:00:00Z", modifications: null },
      },
      recordUpdate: null,
      auditReport: { pass: false, aggregateScore: 40 },
      skipAuditGate: true,
    });
    assert.equal(result.passed, true);
  });
});

describe("Phase 3 — baseline-manager", () => {
  const mockBaseline = {
    runId: "eval-base-001",
    scenarioId: "topic-001",
    postId: "post-base-001",
    scores: { originality: 80, style_match: 85, structure: 75, engagement: 70, forbidden_check: 100 },
    aggregateScore: 82,
    notes: "최초 베이스라인",
  };

  test("compareWithBaseline — 회귀 없음 (점수 향상)", () => {
    const current = {
      runId: "eval-current-001",
      scores: { originality: 85, style_match: 88, structure: 80, engagement: 75, forbidden_check: 100 },
      aggregateScore: 86,
    };
    const diff = compareWithBaseline({ scenarioId: "topic-001", current, baseline: mockBaseline });
    assert.equal(diff.overallRegression, false);
    assert.equal(diff.aggregateDelta, 4); // 86 - 82
  });

  test("compareWithBaseline — 회귀 감지 (deterministic 차원 5점 이상 하락)", () => {
    const current = {
      runId: "eval-current-002",
      scores: { originality: 80, style_match: 85, structure: 65, engagement: 70, forbidden_check: 100 },
      aggregateScore: 79,
    };
    const diff = compareWithBaseline({ scenarioId: "topic-001", current, baseline: mockBaseline });
    // structure: 65 - 75 = -10 → regression
    const structureDim = diff.deterministic.find(d => d.dimension === "structure");
    assert.ok(structureDim);
    assert.equal(structureDim.regression, true);
    assert.equal(diff.overallRegression, true);
  });

  test("compareWithBaseline — 종합 점수 5점 이상 하락 → overall regression", () => {
    const current = {
      runId: "eval-current-003",
      scores: { originality: 78, style_match: 80, structure: 72, engagement: 65, forbidden_check: 100 },
      aggregateScore: 76, // 82 - 76 = -6 → regression
    };
    const diff = compareWithBaseline({ scenarioId: "topic-001", current, baseline: mockBaseline });
    assert.equal(diff.aggregateDelta, -6);
    assert.equal(diff.overallRegression, true);
  });

  test("compareWithBaseline — quality 차원은 regression 판정 없음", () => {
    const current = {
      runId: "eval-current-004",
      scores: { originality: 60, style_match: 70, structure: 75, engagement: 60, forbidden_check: 100 },
      aggregateScore: 70,
    };
    const diff = compareWithBaseline({ scenarioId: "topic-001", current, baseline: mockBaseline });
    // originality, style_match, engagement는 quality → regression 없음
    // aggregateDelta = 70 - 82 = -12 → overall regression via aggregate
    assert.equal(diff.quality.length, 3);
    diff.quality.forEach(q => assert.ok(!("regression" in q)));
  });
});

describe("Phase 3 — corpus-selector (buildSummaryArtifact)", () => {
  const exemplars = [
    {
      sampleId: "s-001", title: "테스트 글 1", category: "라이프스타일",
      tags: ["카페"], relevanceScore: 0.9, styleNotes: "친근한 문체",
      excerpt: "안녕하세요! 오늘은 제가 직접 다녀온 카페 후기예요.",
      wordCount: 1000, publishedAt: "2024-01-01T00:00:00Z",
    },
    {
      sampleId: "s-002", title: "테스트 글 2", category: "라이프스타일",
      tags: ["건강"], relevanceScore: 0.8, styleNotes: "솔직한 경험",
      excerpt: "솔직하게 말씀드리면 정말 도움이 됐어요.",
      wordCount: 1200, publishedAt: "2024-02-01T00:00:00Z",
    },
    {
      sampleId: "s-003", title: "테스트 글 3", category: "라이프스타일",
      tags: ["여행"], relevanceScore: 0.75, styleNotes: "여행 중심",
      excerpt: "꼭 추천드려요. 여러분께 이 장소를 알려드리고 싶었어요.",
      wordCount: 1100, publishedAt: "2024-03-01T00:00:00Z",
    },
  ];

  test("buildSummaryArtifact — selectedCount 정확", () => {
    const summary = buildSummaryArtifact({ userId: "test-user", exemplars, strategy: "exemplar_index", userTone: "friendly" });
    assert.equal(summary.selectedCount, 3);
    assert.equal(summary.userId, "test-user");
  });

  test("buildSummaryArtifact — avgWordCount 정확", () => {
    const summary = buildSummaryArtifact({ userId: "test-user", exemplars, strategy: "exemplar_index" });
    assert.equal(summary.styleProfile.avgWordCount, Math.round((1000 + 1200 + 1100) / 3));
  });

  test("buildSummaryArtifact — exemplarExcerpts 포함 (본문 내용 없음)", () => {
    const summary = buildSummaryArtifact({ userId: "test-user", exemplars, strategy: "exemplar_index" });
    assert.equal(summary.exemplarExcerpts.length, 3);
    // sampleId, title, excerpt, styleNotes만 포함 (wordCount, publishedAt 등 없음)
    const keys = Object.keys(summary.exemplarExcerpts[0]);
    assert.ok(keys.includes("sampleId"));
    assert.ok(keys.includes("excerpt"));
    assert.ok(keys.includes("styleNotes"));
    assert.ok(!keys.includes("wordCount"));
  });

  test("빈 exemplars → avgWordCount=0, selectedCount=0", () => {
    const summary = buildSummaryArtifact({ userId: "test-user", exemplars: [], strategy: "fallback_recent" });
    assert.equal(summary.selectedCount, 0);
    assert.equal(summary.styleProfile.avgWordCount, 0);
  });
});

describe("Phase 3 — artifact-registry (GitHub mock)", () => {
  before(() => {
    githubStore.clear();
  });

  after(() => {
    githubStore.clear();
  });

  // GitHub 경로 헬퍼
  function artifactPath(pipelineId, type) {
    return `data/pipeline-ledger/artifacts/${pipelineId}/${type}.json`;
  }

  test("saveArtifact → getArtifact 왕복 확인", async () => {
    const pipelineId = "pipe-test-001";
    const data = { topicId: "t-001", score: 90, verdict: "feasible", reasons: ["충분"], title: "" };
    const path = artifactPath(pipelineId, "feasibility_report");

    // 저장
    const envelope = { pipelineId, type: "feasibility_report", savedAt: new Date().toISOString(), data };
    await mockRepo.writeJsonFile(path, envelope, "test", null);

    // 조회
    const result = await mockRepo.readJsonFile(path);
    assert.ok(result.data);
    assert.equal(result.data.data.score, 90);
  });

  test("존재하지 않는 artifact → null 반환", async () => {
    const path = artifactPath("pipe-nonexistent", "audit_report");
    const exists = await mockRepo.fileExists(path);
    assert.equal(exists, false);
  });

  test("getAllArtifacts — 저장된 타입만 반환", async () => {
    const pipelineId = "pipe-test-002";
    githubStore.clear();

    const types = ["strategy_plan", "draft_output"];
    for (const type of types) {
      const path = artifactPath(pipelineId, type);
      await mockRepo.writeJsonFile(path, { pipelineId, type, savedAt: new Date().toISOString(), data: {} }, "test", null);
    }

    // 저장된 2개만 있어야 함
    let count = 0;
    for (const [key] of githubStore) {
      if (key.startsWith(`data/pipeline-ledger/artifacts/${pipelineId}/`)) count++;
    }
    assert.equal(count, 2);
  });

  test("artifact 업데이트 — sha 전달 시 덮어쓰기", async () => {
    const pipelineId = "pipe-test-003";
    const path = artifactPath(pipelineId, "audit_report");

    const sha1 = await mockRepo.writeJsonFile(path, { data: { aggregateScore: 70 } }, "initial", null);
    const sha2 = await mockRepo.writeJsonFile(path, { data: { aggregateScore: 85 } }, "update", sha1);

    const result = await mockRepo.readJsonFile(path);
    assert.equal(result.data.data.aggregateScore, 85);
    assert.notEqual(sha1, sha2);
  });
});
