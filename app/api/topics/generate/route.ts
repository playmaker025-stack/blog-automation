import { NextRequest, NextResponse } from "next/server";
import { runTopicGenerator } from "@/lib/agents/topic-generator";
import { readJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { TopicIndex, Topic } from "@/lib/types/github-data";
import { normalizeUserId } from "@/lib/utils/normalize";

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { userId?: string };
  const userId = body.userId?.trim();

  if (!userId) {
    return NextResponse.json({ error: "userId가 필요합니다." }, { status: 400 });
  }

  // 해당 사용자의 토픽 로드
  const path = Paths.topicsIndex();
  if (!(await fileExists(path))) {
    return NextResponse.json({ error: "글목록 파일이 없습니다." }, { status: 404 });
  }

  const { data: index } = await readJsonFile<TopicIndex>(path);
  const uid = normalizeUserId(userId);
  const userTopics = index.topics.filter(
    (t) => normalizeUserId(t.assignedUserId ?? "") === uid
  );

  if (userTopics.length === 0) {
    return NextResponse.json({ error: "해당 사용자의 글목록이 없습니다." }, { status: 404 });
  }

  const publishedTopics = userTopics.filter((t: Topic) => t.status === "published");
  const unpublishedCount = userTopics.filter(
    (t: Topic) => t.status !== "published" && t.status !== "archived"
  ).length;

  if (unpublishedCount > 0) {
    return NextResponse.json(
      {
        error: `아직 발행되지 않은 글이 ${unpublishedCount}개 있습니다. 모두 발행 완료 후 새 글목록을 생성할 수 있습니다.`,
      },
      { status: 409 }
    );
  }

  if (publishedTopics.length === 0) {
    return NextResponse.json(
      { error: "발행된 글이 없습니다. 최소 1개 이상 발행 후 사용할 수 있습니다." },
      { status: 409 }
    );
  }

  try {
    const result = await runTopicGenerator({
      userId,
      publishedTopics,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "토픽 생성 실패" },
      { status: 500 }
    );
  }
}
