import { NextRequest, NextResponse } from "next/server";
import { readJsonFile, writeJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { PostingIndex, PostingRecord } from "@/lib/types/github-data";

const EMPTY_INDEX: PostingIndex = { posts: [], lastUpdated: "" };

async function loadIndex(): Promise<{ data: PostingIndex; sha: string | null }> {
  const path = Paths.postingListIndex();
  if (!(await fileExists(path))) {
    return { data: { ...EMPTY_INDEX, lastUpdated: new Date().toISOString() }, sha: null };
  }
  const { data, sha } = await readJsonFile<PostingIndex>(path);
  return { data, sha };
}

export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get("userId");
  const status = request.nextUrl.searchParams.get("status");
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? "20");

  try {
    const { data: index } = await loadIndex();
    let posts = index.posts;
    if (userId) posts = posts.filter((p) => p.userId === userId);
    if (status) posts = posts.filter((p) => p.status === status);

    // 최신 순 정렬
    posts = posts
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      )
      .slice(0, limit);

    return NextResponse.json({ posts });
  } catch (err) {
    console.error("[GET /api/github/posts]", err);
    return NextResponse.json({ error: "포스팅 목록 조회 실패" }, { status: 500 });
  }
}

// 인덱스 항목 수정
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json() as { postId: string } & Partial<PostingRecord>;
    if (!body.postId) {
      return NextResponse.json({ error: "postId가 필요합니다." }, { status: 400 });
    }

    const { data: index, sha } = await loadIndex();
    const exists = index.posts.find((p) => p.postId === body.postId);
    if (!exists) {
      return NextResponse.json({ error: "포스팅을 찾을 수 없습니다." }, { status: 404 });
    }

    const now = new Date().toISOString();
    const { postId, ...patch } = body;
    const updated: PostingIndex = {
      posts: index.posts.map((p) =>
        p.postId === postId ? { ...p, ...patch, updatedAt: now } : p
      ),
      lastUpdated: now,
    };

    await writeJsonFile(
      Paths.postingListIndex(),
      updated,
      `chore: update post ${postId}`,
      sha
    );

    return NextResponse.json({ updated: true });
  } catch (err) {
    console.error("[PATCH /api/github/posts]", err);
    return NextResponse.json({ error: "포스팅 수정 실패" }, { status: 500 });
  }
}

// 인덱스 항목 삭제
export async function DELETE(request: NextRequest) {
  const postId = request.nextUrl.searchParams.get("postId");
  if (!postId) {
    return NextResponse.json({ error: "postId가 필요합니다." }, { status: 400 });
  }

  try {
    const { data: index, sha } = await loadIndex();
    const before = index.posts.length;
    const updated: PostingIndex = {
      posts: index.posts.filter((p) => p.postId !== postId),
      lastUpdated: new Date().toISOString(),
    };

    if (updated.posts.length === before) {
      return NextResponse.json({ error: "포스팅을 찾을 수 없습니다." }, { status: 404 });
    }

    await writeJsonFile(
      Paths.postingListIndex(),
      updated,
      `chore: delete post ${postId}`,
      sha
    );

    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("[DELETE /api/github/posts]", err);
    return NextResponse.json({ error: "포스팅 삭제 실패" }, { status: 500 });
  }
}

// blog URL에서 블로그 ID 추출 → userId 매핑
async function resolveBlogUserId(blog: string | undefined, url: string | undefined): Promise<string> {
  // blog 컬럼이 이미 userId 형식 (a~e)이면 그대로 사용
  if (blog && /^[a-e]$/i.test(blog.trim())) return blog.trim().toLowerCase();

  // URL에서 블로그 ID 추출
  const blogId = url?.match(/blog\.naver\.com\/([^/?#]+)/)?.[1]?.toLowerCase()
    ?? blog?.toLowerCase().replace(/블로그$/, "").trim();

  if (!blogId) return "imported";

  // 프로필 조회로 매핑
  try {
    const { readJsonFile, fileExists } = await import("@/lib/github/repository");
    const { Paths } = await import("@/lib/github/paths");
    for (const uid of ["a", "b", "c", "d", "e"]) {
      const path = Paths.userProfile(uid);
      if (!(await fileExists(path))) continue;
      const { data } = await readJsonFile<{ naverBlogUrl?: string }>(path);
      const profileBlogId = data.naverBlogUrl?.match(/blog\.naver\.com\/([^/?#]+)/)?.[1]?.toLowerCase();
      if (profileBlogId && profileBlogId === blogId) return uid;
    }
  } catch {
    // 조회 실패 시 fallthrough
  }
  return "imported";
}

// 일괄 가져오기 — 한 번에 읽고 한 번에 쓰기 (SHA 충돌 방지)
// body: { records: Array<{ title: string; url?: string; userId?: string; blog?: string }> }
export async function PUT(request: NextRequest) {
  try {
    const body = await request.json() as {
      records: Array<{ title: string; url?: string; userId?: string; blog?: string }>;
    };
    if (!Array.isArray(body.records) || body.records.length === 0) {
      return NextResponse.json({ error: "records 배열이 필요합니다." }, { status: 400 });
    }

    const { data: index, sha } = await loadIndex();
    const now = new Date().toISOString();

    // 중복 감지: URL 또는 제목이 이미 존재하는 항목 제외
    const existingUrls = new Set(
      index.posts.map((p) => p.naverPostUrl?.toLowerCase()).filter(Boolean)
    );
    const existingTitles = new Set(index.posts.map((p) => p.title.toLowerCase()));

    const { randomUUID } = await import("crypto");
    let duplicates = 0;
    const newPosts: PostingRecord[] = [];

    for (const r of body.records) {
      const urlKey = r.url?.trim().toLowerCase();
      const titleKey = r.title.trim().toLowerCase();
      if ((urlKey && existingUrls.has(urlKey)) || existingTitles.has(titleKey)) {
        duplicates++;
        continue;
      }
      const resolvedUserId = r.userId ?? await resolveBlogUserId(r.blog, r.url);
      newPosts.push({
        postId: `post-import-${randomUUID().slice(0, 8)}`,
        topicId: "",
        userId: resolvedUserId,
        title: r.title.trim(),
        status: "published" as const,
        naverPostUrl: r.url?.trim() || null,
        evalScore: null,
        wordCount: 0,
        compositionSessionId: null,
        pendingApproval: null,
        publishedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      // 이번 배치 내 중복도 방지
      if (urlKey) existingUrls.add(urlKey);
      existingTitles.add(titleKey);
    }

    if (newPosts.length > 0) {
      const updated: PostingIndex = {
        posts: [...index.posts, ...newPosts],
        lastUpdated: now,
      };
      await writeJsonFile(
        Paths.postingListIndex(),
        updated,
        `feat: bulk import ${newPosts.length} posts`,
        sha
      );
    }

    return NextResponse.json({ added: newPosts.length, duplicates });
  } catch (err) {
    console.error("[PUT /api/github/posts]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "일괄 가져오기 실패" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Omit<PostingRecord, "createdAt" | "updatedAt">;

    if (!body.postId || !body.userId || !body.title) {
      return NextResponse.json(
        { error: "postId, userId, title이 필요합니다." },
        { status: 400 }
      );
    }

    const { data: index, sha } = await loadIndex();

    const now = new Date().toISOString();
    const newRecord: PostingRecord = {
      ...body,
      status: body.status ?? "draft",
      naverPostUrl: body.naverPostUrl ?? null,
      evalScore: body.evalScore ?? null,
      wordCount: body.wordCount ?? 0,
      compositionSessionId: body.compositionSessionId ?? null,
      pendingApproval: body.pendingApproval ?? null,
      publishedAt: body.publishedAt ?? null,
      createdAt: now,
      updatedAt: now,
    };

    const updated: PostingIndex = {
      posts: [...index.posts, newRecord],
      lastUpdated: now,
    };

    await writeJsonFile(
      Paths.postingListIndex(),
      updated,
      `feat: add post record "${newRecord.title}"`,
      sha
    );

    return NextResponse.json({ post: newRecord }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/github/posts]", err);
    return NextResponse.json({ error: "포스팅 기록 생성 실패" }, { status: 500 });
  }
}
