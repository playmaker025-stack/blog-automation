/**
 * RemainingTopicResolver
 *
 * topicId 비교 금지 — 임포트된 posts는 topicId=""이므로 구조적으로 불가
 *
 * 3-key 매칭:
 *   1. normalize(userId)
 *   2. normalize(blog)   — Topic: blogCode(category), Post: userId.toUpperCase()
 *   3. normalize(title)
 */

import { normalize } from "@/lib/utils/normalize";
import { blogCode, userIdToBlogCode } from "@/lib/utils/blog-code";
import type { Topic, PostingRecord } from "@/lib/types/github-data";

export interface ResolveResult {
  remaining: Topic[];    // 아직 작성되지 않은 topics
  matched: Topic[];      // 인덱스에 이미 존재하는 topics
  remaining_count: number;
  matched_count: number;
}

/** posts 목록에서 매칭 키 집합 생성 (3-key) */
function buildPostKeySet(posts: PostingRecord[]): Set<string> {
  const keys = new Set<string>();
  for (const p of posts) {
    const blog = userIdToBlogCode(p.userId);
    keys.add(normalize(p.userId) + "||" + normalize(blog) + "||" + normalize(p.title));
  }
  return keys;
}

/** Topic → 3-key */
function topicKey(t: Topic): string {
  const uid = t.assignedUserId ?? "";
  const blog = blogCode(t.category) ?? userIdToBlogCode(uid);
  return normalize(uid) + "||" + normalize(blog) + "||" + normalize(t.title);
}

/**
 * 주어진 topics 중 posts에 이미 존재하는 항목을 분리해 반환
 */
export function resolveRemainingTopics(
  topics: Topic[],
  posts: PostingRecord[]
): ResolveResult {
  const postKeys = buildPostKeySet(posts);
  const remaining: Topic[] = [];
  const matched: Topic[] = [];

  for (const t of topics) {
    if (postKeys.has(topicKey(t))) {
      matched.push(t);
    } else {
      remaining.push(t);
    }
  }

  return {
    remaining,
    matched,
    remaining_count: remaining.length,
    matched_count: matched.length,
  };
}
