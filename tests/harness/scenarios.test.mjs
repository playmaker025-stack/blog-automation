/**
 * Phase 2.5 하네스 검증 — 5개 시나리오
 * Node.js 내장 test runner 사용 (node:test)
 *
 * 실행: node --experimental-vm-modules tests/harness/scenarios.test.mjs
 * 또는: node tests/harness/scenarios.test.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ============================================================
// 순수 함수만 직접 import (GitHub I/O 없음)
// ============================================================

// 타입스크립트 파일을 직접 import할 수 없으므로
// 비즈니스 로직을 여기서 인라인으로 재현 (동일 로직)

// --- completion-checker 인라인 구현 ---

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0
    )
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

function titleSimilarity(a, b) {
  const s1 = a.toLowerCase().replace(/\s+/g, "");
  const s2 = b.toLowerCase().replace(/\s+/g, "");
  if (s1 === s2) return 1;
  if (!s1.length || !s2.length) return 0;
  const maxLen = Math.max(s1.length, s2.length);
  return 1 - levenshtein(s1, s2) / maxLen;
}

const MATERIAL_THRESHOLD = 0.45;

function isMaterialChange(originalTitle, proposedTitle) {
  if (!originalTitle) return false;
  return titleSimilarity(originalTitle, proposedTitle) < MATERIAL_THRESHOLD;
}

function isTopicComplete(topicId, posts, topics) {
  const matchPost = posts.find((p) => p.topicId === topicId && p.status === "published");
  const matchTopic = topics.find((t) => t.topicId === topicId && t.status === "published");
  if (!matchPost && !matchTopic) return { complete: false, reason: "posting-list와 index 모두 미발행" };
  if (!matchPost) return { complete: false, reason: "posting-list에 published 레코드 없음" };
  if (!matchTopic) return { complete: false, reason: "index에 published 레코드 없음" };
  return { complete: true, reason: "posting-list + index 모두 published" };
}

function validateTopicSelection(topicId, topics) {
  const topic = topics.find((t) => t.topicId === topicId);
  if (!topic) return { valid: false, reason: `topicId "${topicId}"가 index에 없습니다.` };
  if (topic.status === "published") return { valid: false, reason: "이미 발행된 토픽입니다." };
  if (topic.status === "archived") return { valid: false, reason: "보관된 토픽은 선택할 수 없습니다." };
  if (topic.status === "in-progress") return { valid: false, reason: "현재 진행 중인 토픽입니다." };
  return { valid: true, reason: `토픽 "${topic.title}" 선택 가능` };
}

class ApprovalGate {
  #approved = false;
  #pipelineId;
  constructor(id) { this.#pipelineId = id; }
  grant() { this.#approved = true; }
  get approved() { return this.#approved; }
  assertApproved() {
    if (!this.#approved) {
      throw new Error(
        `[ApprovalGate] 파이프라인 "${this.#pipelineId}": 승인 없이 index update 시도 차단`
      );
    }
  }
}

// ============================================================
// 테스트 픽스처
// ============================================================

const TOPIC_ID = "topic-abc123";

const FIXTURE_TOPICS = [
  {
    topicId: TOPIC_ID,
    title: "서울 성수동 카페 투어",
    status: "draft",
    category: "여행",
    tags: ["서울", "카페"],
    assignedUserId: "user-001",
  },
  {
    topicId: "topic-done",
    title: "이미 발행된 토픽",
    status: "published",
    category: "여행",
    tags: [],
    assignedUserId: "user-001",
  },
  {
    topicId: "topic-wip",
    title: "진행 중 토픽",
    status: "in-progress",
    category: "음식",
    tags: [],
    assignedUserId: "user-001",
  },
];

const FIXTURE_POSTS_PUBLISHED = [
  {
    postId: "post-001",
    topicId: TOPIC_ID,
    userId: "user-001",
    title: "서울 성수동 카페 투어",
    status: "published",
    evalScore: 85,
    wordCount: 1500,
  },
];

const FIXTURE_POSTS_EMPTY = [];

// ============================================================
// 시나리오 1: posting-list 있고 index 있는 정상 케이스
// ============================================================

describe("시나리오 1: posting-list + index 정상 케이스", () => {
  test("두 데이터 모두 published → complete: true", () => {
    const topicsPublished = [
      ...FIXTURE_TOPICS.filter((t) => t.topicId !== TOPIC_ID),
      { ...FIXTURE_TOPICS[0], status: "published" },
    ];
    const result = isTopicComplete(TOPIC_ID, FIXTURE_POSTS_PUBLISHED, topicsPublished);
    assert.equal(result.complete, true, result.reason);
    console.log(`  ✓ ${result.reason}`);
  });

  test("posting-list posted, index published → complete: true", () => {
    const topicsPublished = FIXTURE_TOPICS.map((t) =>
      t.topicId === TOPIC_ID ? { ...t, status: "published" } : t
    );
    const result = isTopicComplete(TOPIC_ID, FIXTURE_POSTS_PUBLISHED, topicsPublished);
    assert.equal(result.complete, true);
    console.log(`  ✓ 정상 완료 판정`);
  });
});

// ============================================================
// 시나리오 2: posting-list 없음 / index 있음
// ============================================================

describe("시나리오 2: posting-list 없음, index 있음", () => {
  test("posting-list 비어있으면 complete: false", () => {
    const topicsPublished = FIXTURE_TOPICS.map((t) =>
      t.topicId === TOPIC_ID ? { ...t, status: "published" } : t
    );
    const result = isTopicComplete(TOPIC_ID, FIXTURE_POSTS_EMPTY, topicsPublished);
    assert.equal(result.complete, false);
    assert.match(result.reason, /posting-list/);
    console.log(`  ✓ posting-list 없음 → 미완료 판정: ${result.reason}`);
  });

  test("posting-list에 해당 topicId 없으면 complete: false", () => {
    const postsOtherTopic = [{ ...FIXTURE_POSTS_PUBLISHED[0], topicId: "topic-other" }];
    const topicsPublished = FIXTURE_TOPICS.map((t) =>
      t.topicId === TOPIC_ID ? { ...t, status: "published" } : t
    );
    const result = isTopicComplete(TOPIC_ID, postsOtherTopic, topicsPublished);
    assert.equal(result.complete, false);
    console.log(`  ✓ 다른 topicId의 posting-list → 미완료 판정`);
  });

  test("두 곳 모두 비어있으면 complete: false (이유 명시)", () => {
    const result = isTopicComplete(TOPIC_ID, [], FIXTURE_TOPICS);
    assert.equal(result.complete, false);
    assert.match(result.reason, /모두 미발행/);
    console.log(`  ✓ 양쪽 없음 → ${result.reason}`);
  });
});

// ============================================================
// 시나리오 3: 사용자가 직접 주제 선택
// ============================================================

describe("시나리오 3: 사용자 직접 주제 선택 유효성", () => {
  test("draft 토픽 선택 → valid: true", () => {
    const result = validateTopicSelection(TOPIC_ID, FIXTURE_TOPICS);
    assert.equal(result.valid, true);
    console.log(`  ✓ ${result.reason}`);
  });

  test("없는 topicId 선택 → valid: false", () => {
    const result = validateTopicSelection("topic-nonexistent", FIXTURE_TOPICS);
    assert.equal(result.valid, false);
    assert.match(result.reason, /index에 없습니다/);
    console.log(`  ✓ ${result.reason}`);
  });

  test("published 토픽 선택 시도 → valid: false", () => {
    const result = validateTopicSelection("topic-done", FIXTURE_TOPICS);
    assert.equal(result.valid, false);
    assert.match(result.reason, /이미 발행/);
    console.log(`  ✓ ${result.reason}`);
  });

  test("in-progress 토픽 선택 시도 → valid: false", () => {
    const result = validateTopicSelection("topic-wip", FIXTURE_TOPICS);
    assert.equal(result.valid, false);
    assert.match(result.reason, /진행 중/);
    console.log(`  ✓ ${result.reason}`);
  });
});

// ============================================================
// 시나리오 4: material_change 발생
// ============================================================

describe("시나리오 4: material_change 감지", () => {
  test("완전히 다른 제목 → material_change: true", () => {
    const original = "서울 성수동 카페 투어";
    const proposed = "제주도 흑돼지 맛집 완벽 정리 — 직접 먹어본 솔직 후기";
    const result = isMaterialChange(original, proposed);
    assert.equal(result, true);
    const sim = titleSimilarity(original, proposed);
    console.log(`  ✓ material_change=true (유사도: ${sim.toFixed(3)}, 기준: ${MATERIAL_THRESHOLD})`);
  });

  test("소폭 수정 (부제목 추가) → material_change: false", () => {
    const original = "서울 성수동 카페 투어";
    const proposed = "서울 성수동 카페 투어 — 직접 가본 솔직 후기";
    const result = isMaterialChange(original, proposed);
    assert.equal(result, false);
    const sim = titleSimilarity(original, proposed);
    console.log(`  ✓ material_change=false (유사도: ${sim.toFixed(3)})`);
  });

  test("동일 제목 → material_change: false", () => {
    const title = "서울 성수동 카페 투어";
    assert.equal(isMaterialChange(title, title), false);
    console.log(`  ✓ 동일 제목 → material_change=false`);
  });

  test("원본 제목 없음 → material_change: false (신규 토픽)", () => {
    assert.equal(isMaterialChange("", "어떤 새 제목"), false);
    console.log(`  ✓ 원본 없음 → material_change=false (신규 토픽으로 처리)`);
  });
});

// ============================================================
// 시나리오 5: 승인 전 index update 시도 차단
// ============================================================

describe("시나리오 5: 승인 게이트 — index update 차단", () => {
  test("gate.grant() 전 assertApproved() → Error 발생", () => {
    const gate = new ApprovalGate("pipe-test-001");
    assert.throws(
      () => gate.assertApproved(),
      (err) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /승인 없이 index update/);
        return true;
      }
    );
    console.log("  ✓ 승인 전 index update 차단 확인");
  });

  test("gate.grant() 후 assertApproved() → 통과", () => {
    const gate = new ApprovalGate("pipe-test-002");
    gate.grant();
    assert.doesNotThrow(() => gate.assertApproved());
    console.log("  ✓ 승인 후 index update 허용 확인");
  });

  test("파이프라인 흐름 시뮬레이션: posting-list 먼저 → 승인 → index update", () => {
    const gate = new ApprovalGate("pipe-test-003");
    const log = [];

    // 1. posting-list 업데이트 (승인 전에도 가능)
    log.push("posting-list updated");

    // 2. 승인 전 index update 시도 → 차단
    let blocked = false;
    try {
      gate.assertApproved();
      log.push("index updated (WRONG — should be blocked)");
    } catch {
      blocked = true;
      log.push("index update BLOCKED (correct)");
    }

    assert.equal(blocked, true, "승인 전 index update가 차단되어야 합니다");

    // 3. 승인
    gate.grant();
    log.push("approval granted");

    // 4. 승인 후 index update → 허용
    gate.assertApproved();
    log.push("index updated");

    assert.deepEqual(log, [
      "posting-list updated",
      "index update BLOCKED (correct)",
      "approval granted",
      "index updated",
    ]);

    console.log("  ✓ 순서 검증: posting-list → [차단] → 승인 → index");
    log.forEach((entry) => console.log(`    ${entry}`));
  });
});

// ============================================================
// 요약
// ============================================================

console.log("\n========================================");
console.log("Phase 2.5 하네스 검증 시나리오 실행 완료");
console.log("========================================");
