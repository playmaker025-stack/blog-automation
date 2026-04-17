/**
 * RemainingTopicResolver
 *
 * topicId 비교 금지 — 임포트된 posts는 topicId=""이므로 구조적으로 불가
 *
 * 매칭 전략 (2-pass):
 *   1) exact 3-key: normalize(userId) + normalize(blog) + normalize(title)
 *   2) token-prefix fallback: 동일 uid+blog 내에서, topic 토큰열이 post 토큰열의
 *      단어 경계 prefix이면 매칭 (구분자 |/–/—/-/,/:/(/) 등은 공백 처리)
 *
 * false positive 방지:
 *   - 한 post는 최대 1개 topic과만 매칭 (postId 소비 추적)
 *   - 동일 uid+blog 파티션 안에서만 비교
 *   - topic 토큰이 3개 미만이면 prefix 매칭 비활성 (과도 매칭 차단)
 */

import { normalize } from "@/lib/utils/normalize";
import { blogCode, userIdToBlogCode } from "@/lib/utils/blog-code";
import type { Topic, PostingRecord } from "@/lib/types/github-data";

export interface ResolveResult {
  remaining: Topic[];
  matched: Topic[];
  remaining_count: number;
  matched_count: number;
}

const SEPARATORS_REGEX = /[|()\[\]{}·•,:;~?!"'–—\-]/g;

/** 단어 경계 매칭용 정규화: 구분자류를 공백으로 치환 후 토큰화 */
function normalizeForMatch(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\r\n]+/g, " ")
    .replace(SEPARATORS_REGEX, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s: string): string[] {
  const n = normalizeForMatch(s);
  return n === "" ? [] : n.split(" ");
}

/** topic 토큰열이 post 토큰열의 단어 경계 prefix 인가 */
function isTokenPrefix(topic: string[], post: string[]): boolean {
  if (topic.length === 0 || topic.length > post.length) return false;
  for (let i = 0; i < topic.length; i++) {
    if (topic[i] !== post[i]) return false;
  }
  return true;
}

function postExactKey(p: PostingRecord): string {
  const blog = userIdToBlogCode(p.userId);
  return normalize(p.userId) + "||" + normalize(blog) + "||" + normalize(p.title);
}

function topicExactKey(t: Topic): string {
  const uid = t.assignedUserId ?? "";
  const blog = blogCode(t.category) ?? userIdToBlogCode(uid);
  return normalize(uid) + "||" + normalize(blog) + "||" + normalize(t.title);
}

function partitionKey(userId: string, blog: string): string {
  return normalize(userId) + "||" + normalize(blog);
}

/**
 * topics 중 posts에 이미 존재하는 항목을 분리해 반환.
 * 1차: exact key, 2차: token-prefix (동일 uid+blog 내 미소비 post 대상).
 */
export function resolveRemainingTopics(
  topics: Topic[],
  posts: PostingRecord[]
): ResolveResult {
  // exact key → post 목록 (동일 키의 post가 여러 개일 수 있음)
  const postsByExactKey = new Map<string, PostingRecord[]>();
  for (const p of posts) {
    const k = postExactKey(p);
    const arr = postsByExactKey.get(k);
    if (arr) arr.push(p);
    else postsByExactKey.set(k, [p]);
  }

  // uid+blog 파티션 → post 목록 (prefix fallback 후보군)
  const postsByPartition = new Map<string, PostingRecord[]>();
  for (const p of posts) {
    const k = partitionKey(p.userId, userIdToBlogCode(p.userId));
    const arr = postsByPartition.get(k);
    if (arr) arr.push(p);
    else postsByPartition.set(k, [p]);
  }

  const usedPostIds = new Set<string>();
  const matched: Topic[] = [];
  const firstPassUnmatched: Topic[] = [];

  // 1차: exact match
  for (const t of topics) {
    const k = topicExactKey(t);
    const candidates = postsByExactKey.get(k);
    const free = candidates?.find((p) => !usedPostIds.has(p.postId));
    if (free) {
      usedPostIds.add(free.postId);
      matched.push(t);
    } else {
      firstPassUnmatched.push(t);
    }
  }

  // 2차: token-prefix fallback
  const remaining: Topic[] = [];
  for (const t of firstPassUnmatched) {
    const uid = t.assignedUserId ?? "";
    const blog = blogCode(t.category) ?? userIdToBlogCode(uid);
    const candidates = postsByPartition.get(partitionKey(uid, blog)) ?? [];
    const topicTokens = tokenize(t.title);

    if (topicTokens.length < 3) {
      remaining.push(t);
      continue;
    }

    let matchedPost: PostingRecord | undefined;
    for (const p of candidates) {
      if (usedPostIds.has(p.postId)) continue;
      if (isTokenPrefix(topicTokens, tokenize(p.title))) {
        matchedPost = p;
        break;
      }
    }

    if (matchedPost) {
      usedPostIds.add(matchedPost.postId);
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
