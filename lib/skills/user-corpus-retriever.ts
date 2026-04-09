import { readJsonFile, readFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { CorpusIndex, CorpusSampleMeta, CorpusSample } from "@/lib/types/github-data";
import type {
  UserCorpusRetrieverInput,
  UserCorpusRetrieverOutput,
} from "@/lib/types/skill";

export async function userCorpusRetriever(
  input: UserCorpusRetrieverInput
): Promise<UserCorpusRetrieverOutput> {
  const { userId, limit = 2, category, tags } = input;

  const indexPath = Paths.corpusIndex(userId);
  const indexExists = await fileExists(indexPath);
  if (!indexExists) {
    return { samples: [], totalAvailable: 0 };
  }

  const { data: index } = await readJsonFile<CorpusIndex>(indexPath);

  // 필터링
  let filtered: CorpusSampleMeta[] = index.samples;
  if (category) {
    filtered = filtered.filter((s) => s.category === category);
  }
  if (tags && tags.length > 0) {
    filtered = filtered.filter((s) =>
      tags.some((tag) => s.tags.includes(tag))
    );
  }

  const totalAvailable = filtered.length;

  // 최신 순 정렬 후 limit 적용
  const selected = filtered
    .sort(
      (a, b) =>
        new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    )
    .slice(0, limit);

  // 본문 병렬 로드
  const samples: CorpusSample[] = await Promise.all(
    selected.map(async (meta) => {
      const { content } = await readFile(
        Paths.corpusSample(userId, meta.sampleId)
      );
      return { meta, content };
    })
  );

  return { samples, totalAvailable };
}
