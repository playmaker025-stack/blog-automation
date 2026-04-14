import { NextRequest, NextResponse } from "next/server";
import { runTopicGenerator } from "@/lib/agents/topic-generator";
import { readJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { TopicIndex } from "@/lib/types/github-data";
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

  try {
    const result = await runTopicGenerator({
      userId,
      publishedTopics: userTopics,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "토픽 생성 실패" },
      { status: 500 }
    );
  }
}
