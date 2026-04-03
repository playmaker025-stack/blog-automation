/**
 * GET /api/test/pipeline
 *
 * 전체 파이프라인 사전 검증 에이전트
 * 1. 글목록(topics) 체크
 * 2. 발행 인덱스(posts) 체크
 * 3. 교차 체크 — 써야 할 것 / 이미 쓴 것 분리
 * 4. 사용자 선택 가능 여부 체크 (userId 파라미터 필요)
 * 5. 글쓰기 실제 실행 — 전략 수립 ~ 완료까지 (userId + topicId 파라미터 필요)
 *
 * 쿼리 파라미터:
 *   userId  — 사용자 ID (기본값: a)
 *   topicId — 특정 토픽 ID 지정 (없으면 remaining에서 첫 번째 사용)
 *   step    — 1~5 (기본값: 4, 5는 실제 글쓰기라 명시적으로 step=5 전달 필요)
 */

import { NextRequest, NextResponse } from "next/server";
import { readJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { TopicIndex, PostingIndex } from "@/lib/types/github-data";
import { resolveRemainingTopics } from "@/lib/skills/remaining-topic-resolver";
import { getAnthropicClient, MODELS } from "@/lib/anthropic/client";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type StepResult = {
  step: number;
  name: string;
  ok: boolean;
  detail: unknown;
  error?: string;
};

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const userId = (searchParams.get("userId") ?? "a").trim();
  const topicIdParam = searchParams.get("topicId")?.trim() ?? null;
  const maxStep = parseInt(searchParams.get("step") ?? "4", 10);

  const results: StepResult[] = [];

  // ── Step 1: 글목록(topics) 체크 ──────────────────────────────
  let topics: TopicIndex["topics"] = [];
  try {
    const path = Paths.topicsIndex();
    const exists = await fileExists(path);
    if (!exists) throw new Error("topics index 파일 없음");
    const { data } = await readJsonFile<TopicIndex>(path);
    topics = data.topics;
    results.push({
      step: 1,
      name: "글목록(topics) 체크",
      ok: true,
      detail: {
        total: topics.length,
        byStatus: countBy(topics, "status"),
        sample: topics.slice(0, 3).map((t) => ({
          topicId: t.topicId,
          title: t.title,
          status: t.status,
          assignedUserId: t.assignedUserId,
        })),
      },
    });
  } catch (e) {
    results.push({ step: 1, name: "글목록(topics) 체크", ok: false, detail: null, error: String(e) });
  }
  if (maxStep < 2) return respond(results);

  // ── Step 2: 발행 인덱스(posts) 체크 ──────────────────────────
  let posts: PostingIndex["posts"] = [];
  try {
    const path = Paths.postingListIndex();
    const exists = await fileExists(path);
    if (!exists) {
      results.push({ step: 2, name: "발행 인덱스(posts) 체크", ok: true, detail: { total: 0, note: "인덱스 파일 없음 (첫 실행)" } });
    } else {
      const { data } = await readJsonFile<PostingIndex>(path);
      posts = data.posts;
      results.push({
        step: 2,
        name: "발행 인덱스(posts) 체크",
        ok: true,
        detail: {
          total: posts.length,
          byStatus: countBy(posts, "status"),
          sample: posts.slice(0, 3).map((p) => ({
            postId: p.postId,
            title: p.title,
            userId: p.userId,
            status: p.status,
          })),
        },
      });
    }
  } catch (e) {
    results.push({ step: 2, name: "발행 인덱스(posts) 체크", ok: false, detail: null, error: String(e) });
  }
  if (maxStep < 3) return respond(results);

  // ── Step 3: 교차 체크 ─────────────────────────────────────────
  try {
    const resolved = resolveRemainingTopics(topics, posts);
    results.push({
      step: 3,
      name: "교차 체크 (써야 할 것 / 이미 쓴 것)",
      ok: true,
      detail: {
        remaining_count: resolved.remaining_count,
        matched_count: resolved.matched_count,
        remaining_sample: resolved.remaining.slice(0, 5).map((t) => ({
          topicId: t.topicId,
          title: t.title,
          assignedUserId: t.assignedUserId,
        })),
        matched_sample: resolved.matched.slice(0, 3).map((t) => ({
          topicId: t.topicId,
          title: t.title,
        })),
      },
    });
  } catch (e) {
    results.push({ step: 3, name: "교차 체크", ok: false, detail: null, error: String(e) });
  }
  if (maxStep < 4) return respond(results);

  // ── Step 4: 사용자 선택 가능 여부 체크 ───────────────────────
  try {
    const userTopics = topics.filter(
      (t) => (t.assignedUserId ?? "").toLowerCase() === userId.toLowerCase() && t.status === "draft"
    );
    const resolved = resolveRemainingTopics(userTopics, posts);

    // 사용할 topicId 결정
    const targetTopic = topicIdParam
      ? topics.find((t) => t.topicId === topicIdParam)
      : resolved.remaining[0];

    results.push({
      step: 4,
      name: `사용자 선택 가능 여부 (userId=${userId})`,
      ok: resolved.remaining.length > 0,
      detail: {
        userId,
        userTopics_total: userTopics.length,
        remaining: resolved.remaining_count,
        matched: resolved.matched_count,
        selected_topic: targetTopic
          ? { topicId: targetTopic.topicId, title: targetTopic.title }
          : null,
        warning: resolved.remaining.length === 0 ? "남은 토픽 없음 — 글쓰기 불가" : null,
      },
    });
  } catch (e) {
    results.push({ step: 4, name: "사용자 선택 가능 여부 체크", ok: false, detail: null, error: String(e) });
  }
  if (maxStep < 5) return respond(results);

  // ── Step 5: 실제 글쓰기 테스트 (Anthropic API 호출) ──────────
  try {
    // 사용할 topicId
    const userTopics = topics.filter(
      (t) => (t.assignedUserId ?? "").toLowerCase() === userId.toLowerCase() && t.status === "draft"
    );
    const resolved = resolveRemainingTopics(userTopics, posts);
    const targetTopic = topicIdParam
      ? topics.find((t) => t.topicId === topicIdParam)
      : resolved.remaining[0];

    if (!targetTopic) {
      results.push({ step: 5, name: "글쓰기 실행 테스트", ok: false, detail: null, error: "사용 가능한 토픽 없음" });
      return respond(results);
    }

    // Anthropic API 연결 테스트 (strategy-planner 첫 호출 시뮬레이션)
    const client = getAnthropicClient();
    const start = Date.now();
    const response = await client.messages.create({
      model: MODELS.haiku,
      max_tokens: 64,
      messages: [
        {
          role: "user",
          content: `다음 토픽으로 블로그 포스팅 전략을 한 문장으로 요약해주세요: "${targetTopic.title}"`,
        },
      ],
    });
    const elapsed = Date.now() - start;
    const text = response.content.find((b) => b.type === "text");

    results.push({
      step: 5,
      name: "글쓰기 실행 테스트 (Anthropic API 호출)",
      ok: response.stop_reason === "end_turn" || response.stop_reason === "max_tokens",
      detail: {
        topicId: targetTopic.topicId,
        title: targetTopic.title,
        model: response.model,
        stop_reason: response.stop_reason,
        elapsed_ms: elapsed,
        response_preview: text?.type === "text" ? text.text.slice(0, 120) : null,
      },
    });
  } catch (e) {
    const name = e instanceof Error ? e.constructor.name : "Error";
    const cause = e instanceof Error ? (e as { cause?: unknown }).cause : undefined;
    results.push({
      step: 5,
      name: "글쓰기 실행 테스트 (Anthropic API 호출)",
      ok: false,
      detail: { errorType: name, cause: cause ? String(cause) : null },
      error: String(e),
    });
  }

  return respond(results);
}

function respond(results: StepResult[]) {
  const allOk = results.every((r) => r.ok);
  return NextResponse.json({ ok: allOk, steps: results }, { status: allOk ? 200 : 502 });
}

function countBy<T>(arr: T[], key: keyof T): Record<string, number> {
  return arr.reduce<Record<string, number>>((acc, item) => {
    const val = String((item[key] as unknown) ?? "unknown");
    acc[val] = (acc[val] ?? 0) + 1;
    return acc;
  }, {});
}
