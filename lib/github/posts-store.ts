import { readJsonFile, fileExists, listFiles } from "./repository";
import { Paths } from "./paths";
import type { PostingIndex, PostingRecord } from "@/lib/types/github-data";

/**
 * 포스트 목록을 두 소스에서 합산하여 반환한다.
 *
 * - 파이프라인이 생성한 포스트: data/posting-list/posts/{postId}/meta.json (개별 파일)
 * - 일괄 가져오기 포스트(레거시): data/posting-list/index.json
 *
 * 개별 파일 방식은 서로 다른 사용자가 동시에 쓰더라도 SHA 충돌이 발생하지 않는다.
 * postId 기준으로 중복을 제거하며, 개별 파일이 index.json보다 우선한다.
 */
export async function loadAllPosts(): Promise<PostingRecord[]> {
  const allPosts: PostingRecord[] = [];
  const seenIds = new Set<string>();

  // 1. 개별 meta.json 파일 (파이프라인 생성 포스트)
  try {
    const entries = await listFiles("data/posting-list/posts");
    const dirs = entries.filter((e) => e.type === "dir");
    const reads = dirs.map(async (dir) => {
      try {
        const { data } = await readJsonFile<PostingRecord>(Paths.postMeta(dir.name));
        return data;
      } catch {
        return null;
      }
    });
    const results = await Promise.all(reads);
    for (const r of results) {
      if (r && !seenIds.has(r.postId)) {
        allPosts.push(r);
        seenIds.add(r.postId);
      }
    }
  } catch (err: unknown) {
    if ((err as { status?: number }).status !== 404) throw err;
  }

  // 2. 레거시 index.json (일괄 가져오기 포스트)
  try {
    const indexPath = Paths.postingListIndex();
    if (await fileExists(indexPath)) {
      const { data: index } = await readJsonFile<PostingIndex>(indexPath);
      for (const p of index.posts) {
        if (!seenIds.has(p.postId)) {
          allPosts.push(p);
          seenIds.add(p.postId);
        }
      }
    }
  } catch {
    // index.json 읽기 실패는 치명적이지 않음
  }

  return allPosts;
}

/**
 * 개별 meta.json 또는 index.json 중 해당 postId가 있는 곳에서 레코드를 반환한다.
 * 개별 파일이 있으면 그쪽이 우선한다.
 */
export async function findPost(
  postId: string
): Promise<{ record: PostingRecord; source: "meta" | "index"; sha: string | null } | null> {
  // 개별 파일 시도
  const metaPath = Paths.postMeta(postId);
  if (await fileExists(metaPath)) {
    const { data, sha } = await readJsonFile<PostingRecord>(metaPath);
    return { record: data, source: "meta", sha };
  }

  // index.json fallback
  const indexPath = Paths.postingListIndex();
  if (await fileExists(indexPath)) {
    const { data: index, sha } = await readJsonFile<PostingIndex>(indexPath);
    const record = index.posts.find((p) => p.postId === postId);
    if (record) return { record, source: "index", sha };
  }

  return null;
}
