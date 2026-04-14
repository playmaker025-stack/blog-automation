/**
 * 네이버 블로그 키워드 리서치 스킬
 *
 * 네이버 Search API를 사용해 키워드 경쟁도, 연관 키워드, 롱테일 제안을 반환한다.
 * NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수 필요.
 */

export interface NaverKeywordResearchInput {
  keyword: string;
  /** 상위 블로그 글 제목 수집 개수 (기본 30) */
  display?: number;
}

export interface NaverBlogItem {
  title: string;
  link: string;
  description: string;
  bloggername: string;
  postdate: string;
}

export interface NaverKeywordResearchOutput {
  keyword: string;
  blog: {
    total: number;
    competition: "높음" | "보통" | "낮음";
    recent30dRatioPercent: number;
    topItems: NaverBlogItem[];
  };
  relatedKeywords: Array<{ word: string; count: number }>;
  longtailSuggestions: string[];
  error?: string;
}

const STOP_WORDS = new Set([
  "그리고", "있는", "위한", "통해", "대한", "되는", "하는", "입니다",
  "합니다", "이것", "저것", "우리", "그것", "이런", "저런", "그런",
  "때문", "이후", "경우", "위해", "들이", "으로", "에서", "에게",
]);

function stripTags(s: string): string {
  return (s ?? "").replace(/<[^>]+>/g, "");
}

function competitionLevel(total: number): "높음" | "보통" | "낮음" {
  if (total >= 100_000) return "높음";
  if (total >= 30_000) return "보통";
  return "낮음";
}

function extractRelatedWords(
  items: NaverBlogItem[],
  mainKeyword: string
): Array<{ word: string; count: number }> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const title = stripTags(item.title);
    const words = title
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w) && !title.includes(mainKeyword) === false);
    for (const w of words) {
      if (w === mainKeyword) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([word, count]) => ({ word, count }));
}

function recentRatio(items: NaverBlogItem[], days = 30): number {
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const recent = items.filter((it) => {
    if (!it.postdate || it.postdate.length !== 8) return false;
    const y = it.postdate.slice(0, 4);
    const m = it.postdate.slice(4, 6);
    const d = it.postdate.slice(6, 8);
    return new Date(`${y}-${m}-${d}`).getTime() >= cutoff;
  });
  return items.length ? (recent.length / items.length) * 100 : 0;
}

async function naverSearch(
  kind: "blog" | "cafearticle",
  query: string,
  display: number,
  sort: "sim" | "date"
): Promise<{ total: number; items: NaverBlogItem[] }> {
  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 없습니다.");
  }

  const url =
    `https://openapi.naver.com/v1/search/${kind}` +
    `?query=${encodeURIComponent(query)}&display=${display}&sort=${sort}`;

  const res = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": id,
      "X-Naver-Client-Secret": secret,
    },
    signal: AbortSignal.timeout(10_000),
  });

  const json = (await res.json()) as {
    total?: number;
    items?: NaverBlogItem[];
    errorCode?: string;
    errorMessage?: string;
  };

  if (!res.ok || json.errorCode) {
    throw new Error(
      `Naver API 오류 (${kind}): ${json.errorMessage ?? res.status}`
    );
  }

  return { total: json.total ?? 0, items: json.items ?? [] };
}

export async function naverKeywordResearch(
  input: NaverKeywordResearchInput
): Promise<NaverKeywordResearchOutput> {
  const { keyword, display = 30 } = input;

  try {
    const [byDate, bySim] = await Promise.all([
      naverSearch("blog", keyword, display, "date"),
      naverSearch("blog", keyword, 1, "sim"),
    ]);

    const total = bySim.total;
    const items = byDate.items.map((it) => ({
      ...it,
      title: stripTags(it.title),
      description: stripTags(it.description).slice(0, 200),
    }));

    const relatedKeywords = extractRelatedWords(byDate.items, keyword);
    const recent30dRatioPercent = parseFloat(recentRatio(byDate.items).toFixed(1));

    return {
      keyword,
      blog: {
        total,
        competition: competitionLevel(total),
        recent30dRatioPercent,
        topItems: items.slice(0, 10),
      },
      relatedKeywords,
      longtailSuggestions: relatedKeywords
        .slice(0, 8)
        .map((r) => `${keyword} ${r.word}`),
    };
  } catch (err) {
    return {
      keyword,
      blog: { total: 0, competition: "낮음", recent30dRatioPercent: 0, topItems: [] },
      relatedKeywords: [],
      longtailSuggestions: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
