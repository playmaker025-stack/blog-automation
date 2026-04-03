import { NextRequest, NextResponse } from "next/server";
import { readJsonFile, writeJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { TopicIndex, Topic } from "@/lib/types/github-data";
import { randomUUID } from "crypto";
import { normalizeUserId } from "@/lib/utils/normalize";

const EMPTY_INDEX: TopicIndex = { topics: [], lastUpdated: "" };

async function loadIndex(): Promise<{ data: TopicIndex; sha: string | null }> {
  const path = Paths.topicsIndex();
  if (!(await fileExists(path))) {
    return { data: { ...EMPTY_INDEX, lastUpdated: new Date().toISOString() }, sha: null };
  }
  const { data, sha } = await readJsonFile<TopicIndex>(path);
  return { data, sha };
}

export async function GET(request: NextRequest) {
  const status = request.nextUrl.searchParams.get("status");
  const userId = request.nextUrl.searchParams.get("userId");

  try {
    const { data: index } = await loadIndex();
    let topics = index.topics;
    if (status) topics = topics.filter((t) => t.status === status);
    if (userId) {
      const uid = normalizeUserId(userId);
      topics = topics.filter((t) => normalizeUserId(t.assignedUserId ?? "") === uid);
    }
    return NextResponse.json({ topics });
  } catch (err) {
    console.error("[GET /api/github/topics]", err);
    return NextResponse.json({ error: "토픽 목록 조회 실패" }, { status: 500 });
  }
}

// 글목록 교체 저장 — 진행 중/발행된 항목은 유지하고 나머지를 새 목록으로 교체
// body: { items: Array<{ title: string; blog?: string }> }
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json() as { items: Array<{ title: string; blog?: string }> };
    if (!Array.isArray(body.items) || body.items.length === 0) {
      return NextResponse.json({ error: "items 배열이 필요합니다." }, { status: 400 });
    }

    const { data: existing, sha } = await loadIndex();
    const now = new Date().toISOString();

    const locked = existing.topics.filter(
      (t) => t.status === "in-progress" || t.status === "published"
    );
    const lockedTitles = new Set(locked.map((t) => t.title.toLowerCase().trim()));

    // blog 코드(A~E) → 사용자 ID(a~e) 매핑
    const blogToUserId = (blog?: string): string | null =>
      blog ? blog.toLowerCase() : null;

    const newTopics: Topic[] = body.items
      .filter((item) => !lockedTitles.has(item.title.toLowerCase().trim()))
      .map((item) => ({
        topicId: `topic-${randomUUID().slice(0, 8)}`,
        title: item.title.trim(),
        description: "",
        category: item.blog ? `${item.blog}블로그` : "일반",
        tags: [],
        feasibility: null,
        relatedSources: [],
        status: "draft" as const,
        assignedUserId: blogToUserId(item.blog) ? normalizeUserId(blogToUserId(item.blog)!) : null,
        createdAt: now,
        updatedAt: now,
      }));

    const updated: TopicIndex = {
      topics: [...locked, ...newTopics],
      lastUpdated: now,
    };

    await writeJsonFile(
      Paths.topicsIndex(),
      updated,
      `feat: replace topics list (${newTopics.length} items)`,
      sha
    );

    return NextResponse.json({ replaced: newTopics.length, kept: locked.length });
  } catch (err) {
    console.error("[PUT /api/github/topics]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "글목록 교체 실패" },
      { status: 500 }
    );
  }
}

// 단일 토픽 수정
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json() as { topicId: string } & Partial<Topic>;
    if (!body.topicId) {
      return NextResponse.json({ error: "topicId가 필요합니다." }, { status: 400 });
    }

    const { data: index, sha } = await loadIndex();
    const exists = index.topics.find((t) => t.topicId === body.topicId);
    if (!exists) {
      return NextResponse.json({ error: "토픽을 찾을 수 없습니다." }, { status: 404 });
    }

    const now = new Date().toISOString();
    const { topicId, ...patch } = body;
    const updated: TopicIndex = {
      topics: index.topics.map((t) =>
        t.topicId === topicId ? { ...t, ...patch, topicId, updatedAt: now } : t
      ),
      lastUpdated: now,
    };

    await writeJsonFile(Paths.topicsIndex(), updated, `chore: update topic ${topicId}`, sha);
    return NextResponse.json({ updated: true });
  } catch (err) {
    console.error("[PATCH /api/github/topics]", err);
    return NextResponse.json({ error: "토픽 수정 실패" }, { status: 500 });
  }
}

// 단일 토픽 삭제
export async function DELETE(request: NextRequest) {
  const topicId = request.nextUrl.searchParams.get("topicId");
  if (!topicId) {
    return NextResponse.json({ error: "topicId가 필요합니다." }, { status: 400 });
  }

  try {
    const { data: index, sha } = await loadIndex();
    const target = index.topics.find((t) => t.topicId === topicId);
    if (!target) {
      return NextResponse.json({ error: "토픽을 찾을 수 없습니다." }, { status: 404 });
    }
    if (target.status === "in-progress") {
      return NextResponse.json({ error: "진행 중인 토픽은 삭제할 수 없습니다." }, { status: 400 });
    }

    const updated: TopicIndex = {
      topics: index.topics.filter((t) => t.topicId !== topicId),
      lastUpdated: new Date().toISOString(),
    };

    await writeJsonFile(Paths.topicsIndex(), updated, `chore: delete topic ${topicId}`, sha);
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("[DELETE /api/github/topics]", err);
    return NextResponse.json({ error: "토픽 삭제 실패" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Partial<Topic>;
    if (!body.title) {
      return NextResponse.json({ error: "title이 필요합니다." }, { status: 400 });
    }

    const { data: index, sha } = await loadIndex();

    const now = new Date().toISOString();
    const newTopic: Topic = {
      topicId: `topic-${randomUUID().slice(0, 8)}`,
      title: body.title,
      description: body.description ?? "",
      category: body.category ?? "일반",
      tags: body.tags ?? [],
      feasibility: null,
      relatedSources: body.relatedSources ?? [],
      status: "draft",
      assignedUserId: body.assignedUserId ? normalizeUserId(body.assignedUserId) : null,
      createdAt: now,
      updatedAt: now,
    };

    const updated: TopicIndex = {
      topics: [...index.topics, newTopic],
      lastUpdated: now,
    };

    await writeJsonFile(
      Paths.topicsIndex(),
      updated,
      `feat: add topic "${newTopic.title}"`,
      sha
    );

    return NextResponse.json({ topic: newTopic }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/github/topics]", err);
    return NextResponse.json({ error: "토픽 생성 실패" }, { status: 500 });
  }
}
