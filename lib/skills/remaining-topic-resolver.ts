/**
 * RemainingTopicResolver
 *
 * topicId 비교 금지 — 임포트된 posts는 topicId=""이므로 구조적으로 불가
 * 대신 normalize(userId) + normalize(title) 기반 매칭
 *
 * 결과:
 *   remaining  — 아직 작성되지 않은 topics
 *   duplicate  — 이미 작성된 것으로 판단된 topics
 */

import { normalize } from "@/lib/utils/normalize";
import type { Topic, PostingRecord } from "@/lib/types/github-data";

export interface ResolveResult {
  remaining: Topic[];
  duplicate: Topic[];
  remainingCount: number;
  duplicateCount: number;
}

/**
 * posts 목록에서 매칭 키 집합을 생성
 * 키 = normalize(userId) + "||" + normalize(title)
 */
function buildPostKeySet(posts: PostingRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const p of posts) {
    keys.add(normalize(p.userId) + "||" + normalize(p.title));
  }
  return keys;
}

/**
 * 주어진 topics 중 posts에 이미 존재하는 항목을 제외하고 반환
 */
export function resolveRemainingTopics(
  topics: Topic[],
  posts: PostingRecord[]
): ResolveResult {
  const postKeys = buildPostKeySet(posts);
  const remaining: Topic[] = [];
  const duplicate: Topic[] = [];

  for (const t of topics) {
    const userId = t.assignedUserId ?? "";
    const key = normalize(userId) + "||" + normalize(t.title);
    if (postKeys.has(key)) {
      duplicate.push(t);
    } else {
      remaining.push(t);
    }
  }

  return {
    remaining,
    duplicate,
    remainingCount: remaining.length,
    duplicateCount: duplicate.length,
  };
}
