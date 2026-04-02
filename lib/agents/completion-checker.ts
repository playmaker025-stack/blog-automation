/**
 * 완료 판정·승인 게이트·material_change 감지를 담당하는 순수 함수 모듈.
 * GitHub I/O 없음 → 단위 테스트 가능.
 */

import type { PostingRecord, Topic } from "@/lib/types/github-data";

// ============================================================
// 완료 교차확인 (핵심 원칙 #2)
// posting-list AND index 양쪽 모두 published여야 완료
// ============================================================

export interface CrossCheckResult {
  complete: boolean;
  reason: string;
}

export function isTopicComplete(
  topicId: string,
  posts: PostingRecord[],
  topics: Topic[]
): CrossCheckResult {
  const matchingPost = posts.find(
    (p) => p.topicId === topicId && p.status === "published"
  );
  const matchingTopic = topics.find(
    (t) => t.topicId === topicId && t.status === "published"
  );

  if (!matchingPost && !matchingTopic) {
    return { complete: false, reason: "posting-list와 index 모두 미발행" };
  }
  if (!matchingPost) {
    return { complete: false, reason: "posting-list에 published 레코드 없음 (index만 발행됨)" };
  }
  if (!matchingTopic) {
    return { complete: false, reason: "index에 published 레코드 없음 (posting-list만 발행됨)" };
  }
  return { complete: true, reason: "posting-list + index 모두 published" };
}

// ============================================================
// material_change 감지 (핵심 원칙 #3)
// 제목이나 방향이 실질적으로 바뀌면 true
// ============================================================

const MATERIAL_THRESHOLD = 0.45; // 레벤슈타인 유사도 기준 — 이 이하면 material change

export function isMaterialChange(
  originalTitle: string,
  proposedTitle: string
): boolean {
  if (!originalTitle) return false; // 원본 없으면 변경 없음으로 처리
  const sim = titleSimilarity(originalTitle, proposedTitle);
  return sim < MATERIAL_THRESHOLD;
}

/** 0(완전 다름) ~ 1(동일) */
function titleSimilarity(a: string, b: string): number {
  const s1 = a.toLowerCase().replace(/\s+/g, "");
  const s2 = b.toLowerCase().replace(/\s+/g, "");
  if (s1 === s2) return 1;
  if (s1.length === 0 || s2.length === 0) return 0;

  const maxLen = Math.max(s1.length, s2.length);
  const dist = levenshtein(s1, s2);
  return 1 - dist / maxLen;
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
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

// ============================================================
// 승인 게이트 (핵심 원칙 #3)
// index update는 반드시 승인 후에만 가능
// ============================================================

export class ApprovalGate {
  private _approved = false;
  private _pipelineId: string;

  constructor(pipelineId: string) {
    this._pipelineId = pipelineId;
  }

  grant(): void {
    this._approved = true;
  }

  /** index update 시도 전 반드시 호출 */
  assertApproved(): void {
    if (!this._approved) {
      throw new Error(
        `[ApprovalGate] 파이프라인 "${this._pipelineId}": ` +
          "승인 없이 index update를 시도할 수 없습니다. " +
          "사용자 승인 후 gate.grant()를 먼저 호출하세요."
      );
    }
  }

  get approved(): boolean {
    return this._approved;
  }
}

// ============================================================
// 토픽 선택 유효성 검사
// ============================================================

export interface TopicSelectionResult {
  valid: boolean;
  reason: string;
}

export function validateTopicSelection(
  topicId: string,
  topics: Topic[]
): TopicSelectionResult {
  const topic = topics.find((t) => t.topicId === topicId);
  if (!topic) {
    return { valid: false, reason: `topicId "${topicId}"가 index에 없습니다.` };
  }
  if (topic.status === "published") {
    return { valid: false, reason: "이미 발행된 토픽입니다." };
  }
  if (topic.status === "archived") {
    return { valid: false, reason: "보관된 토픽은 선택할 수 없습니다." };
  }
  if (topic.status === "in-progress") {
    return { valid: false, reason: "현재 진행 중인 토픽입니다. 완료 후 재시도하세요." };
  }
  return { valid: true, reason: `토픽 "${topic.title}" 선택 가능` };
}
