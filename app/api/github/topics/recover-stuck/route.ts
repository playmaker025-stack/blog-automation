import { NextResponse } from "next/server";
import { readJsonFile, writeJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { TopicIndex } from "@/lib/types/github-data";

/**
 * POST /api/github/topics/recover-stuck
 * in-progress 상태로 멈춘 토픽을 일괄 draft로 복구한다.
 * 파이프라인 실패 후 stuck된 토픽 복구용 긴급 엔드포인트.
 */
export async function POST(): Promise<NextResponse> {
  try {
    const topicsPath = Paths.topicsIndex();
    if (!(await fileExists(topicsPath))) {
      return NextResponse.json({ recovered: 0, message: "topics index 없음" });
    }

    const { data: index, sha } = await readJsonFile<TopicIndex>(topicsPath);
    const stuck = index.topics.filter((t) => t.status === "in-progress");

    if (stuck.length === 0) {
      return NextResponse.json({ recovered: 0, message: "멈춤 토픽 없음" });
    }

    const now = new Date().toISOString();
    const updated: TopicIndex = {
      topics: index.topics.map((t) =>
        t.status === "in-progress" ? { ...t, status: "draft", updatedAt: now } : t
      ),
      lastUpdated: now,
    };

    await writeJsonFile(
      topicsPath,
      updated,
      `fix: recover ${stuck.length} stuck in-progress topics → draft [skip ci]`,
      sha
    );

    return NextResponse.json({
      recovered: stuck.length,
      topicIds: stuck.map((t) => t.topicId),
      titles: stuck.map((t) => t.title),
    });
  } catch (err) {
    console.error("[POST /api/github/topics/recover-stuck]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "복구 실패" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/github/topics/recover-stuck
 * 현재 stuck된 토픽 목록만 조회 (복구 미실행).
 */
export async function GET(): Promise<NextResponse> {
  try {
    const topicsPath = Paths.topicsIndex();
    if (!(await fileExists(topicsPath))) {
      return NextResponse.json({ stuck: [], count: 0 });
    }
    const { data: index } = await readJsonFile<TopicIndex>(topicsPath);
    const stuck = index.topics.filter((t) => t.status === "in-progress");
    return NextResponse.json({
      count: stuck.length,
      stuck: stuck.map((t) => ({ topicId: t.topicId, title: t.title, updatedAt: t.updatedAt })),
    });
  } catch {
    return NextResponse.json({ error: "조회 실패" }, { status: 500 });
  }
}
