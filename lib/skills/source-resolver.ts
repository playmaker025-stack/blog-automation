import type {
  SourceResolverInput,
  SourceResolverOutput,
  ResolvedSource,
} from "@/lib/types/skill";

const FETCH_TIMEOUT_MS = 8000;
const MAX_EXCERPT_LENGTH = 300;

/**
 * 참조 URL 유효성 검증 + 제목/요약 추출 스킬
 * 서버 사이드 전용 (외부 HTTP 요청)
 */
export async function sourceResolver(
  input: SourceResolverInput
): Promise<SourceResolverOutput> {
  const results = await Promise.allSettled(
    input.urls.map((url) => resolveOne(url))
  );

  const resolved: ResolvedSource[] = results.map((result, i) => {
    if (result.status === "fulfilled") return result.value;
    return {
      url: input.urls[i],
      title: "",
      excerpt: "",
      accessible: false,
      error: result.reason instanceof Error ? result.reason.message : "알 수 없는 오류",
    };
  });

  return { resolved };
}

async function resolveOne(url: string): Promise<ResolvedSource> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BlogAutomation/1.0)" },
    });
  } catch (err) {
    return {
      url,
      title: "",
      excerpt: "",
      accessible: false,
      error: err instanceof Error ? err.message : "fetch 실패",
    };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return {
      url,
      title: "",
      excerpt: "",
      accessible: false,
      error: `HTTP ${response.status}`,
    };
  }

  const html = await response.text();
  const title = extractTitle(html);
  const excerpt = extractExcerpt(html);

  return { url, title, excerpt, accessible: true };
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return match ? match[1].trim().slice(0, 120) : "";
}

function extractExcerpt(html: string): string {
  // meta description 우선
  const metaMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i
  ) ?? html.match(
    /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i
  );
  if (metaMatch) return metaMatch[1].trim().slice(0, MAX_EXCERPT_LENGTH);

  // fallback: 첫 번째 paragraph 텍스트
  const pMatch = html.match(/<p[^>]*>([^<]{30,})<\/p>/i);
  if (pMatch) {
    return pMatch[1]
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_EXCERPT_LENGTH);
  }

  return "";
}
