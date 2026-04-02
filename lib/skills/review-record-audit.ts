import { readJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { PostingIndex, PostingRecord } from "@/lib/types/github-data";
import type {
  ReviewRecordAuditInput,
  ReviewRecordAuditOutput,
} from "@/lib/types/skill";

export async function reviewRecordAudit(
  input: ReviewRecordAuditInput
): Promise<ReviewRecordAuditOutput> {
  const { userId, limit = 10 } = input;

  const indexExists = await fileExists(Paths.postingListIndex());
  if (!indexExists) {
    return {
      summary: "포스팅 기록이 없습니다.",
      topPerformingCategories: [],
      averageScoreByCategory: {},
      recentPosts: [],
      gaps: [],
    };
  }

  const { data: postingIndex } = await readJsonFile<PostingIndex>(
    Paths.postingListIndex()
  );

  // 해당 사용자 포스팅만 필터링
  const userPosts = postingIndex.posts
    .filter((p) => p.userId === userId && p.status === "published")
    .sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

  const recentPosts = userPosts.slice(0, limit);

  // 카테고리별 평균 점수 계산 (topicId 기반 - 여기서는 postId prefix로 임시 대체)
  const scoreByCategory = computeScoreByCategory(userPosts);

  const topPerformingCategories = Object.entries(scoreByCategory)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([cat]) => cat);

  const gaps = identifyGaps(userPosts);

  const summary = buildSummary(userPosts, topPerformingCategories, scoreByCategory);

  return {
    summary,
    topPerformingCategories,
    averageScoreByCategory: scoreByCategory,
    recentPosts,
    gaps,
  };
}

function computeScoreByCategory(
  posts: PostingRecord[]
): Record<string, number> {
  const categoryMap: Record<string, number[]> = {};

  for (const post of posts) {
    if (post.evalScore === null) continue;
    // topicId의 첫 번째 세그먼트를 카테고리로 사용 (실제로는 topic 데이터 참조 필요)
    const category = post.topicId.split("-")[0] ?? "기타";
    if (!categoryMap[category]) categoryMap[category] = [];
    categoryMap[category].push(post.evalScore);
  }

  const result: Record<string, number> = {};
  for (const [cat, scores] of Object.entries(categoryMap)) {
    result[cat] = Math.round(
      scores.reduce((a, b) => a + b, 0) / scores.length
    );
  }
  return result;
}

function identifyGaps(posts: PostingRecord[]): string[] {
  const gaps: string[] = [];
  const now = new Date();
  const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const recentCount = posts.filter(
    (p) => p.publishedAt && new Date(p.publishedAt) > oneMonthAgo
  ).length;

  if (recentCount === 0) {
    gaps.push("최근 30일 내 발행된 포스팅이 없습니다.");
  }

  const lowScorePosts = posts.filter(
    (p) => p.evalScore !== null && p.evalScore < 60
  );
  if (lowScorePosts.length > 0) {
    gaps.push(`낮은 점수(60점 미만) 포스팅이 ${lowScorePosts.length}건 있습니다. 개선이 필요합니다.`);
  }

  return gaps;
}

function buildSummary(
  posts: PostingRecord[],
  topCategories: string[],
  scoreByCategory: Record<string, number>
): string {
  if (posts.length === 0) {
    return "발행된 포스팅이 없습니다.";
  }

  const avgScore =
    posts
      .filter((p) => p.evalScore !== null)
      .reduce((acc, p) => acc + (p.evalScore ?? 0), 0) /
    Math.max(1, posts.filter((p) => p.evalScore !== null).length);

  const topCatStr =
    topCategories.length > 0
      ? `상위 카테고리: ${topCategories.slice(0, 3).join(", ")}`
      : "카테고리 데이터 부족";

  return (
    `총 ${posts.length}건 발행. 평균 eval 점수: ${Math.round(avgScore)}점. ` +
    `${topCatStr}. ` +
    Object.entries(scoreByCategory)
      .map(([cat, score]) => `${cat}(${score}점)`)
      .join(", ")
  );
}
