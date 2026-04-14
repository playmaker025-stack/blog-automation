/**
 * 네이버 블로그 상위 글 본문 수집 + AI 요약 스킬
 *
 * naverKeywordResearch로 얻은 topItems의 URL들을 실제로 fetch해서
 * 본문 텍스트를 추출하고 Claude로 핵심 내용을 요약한다.
 * 결과는 strategy-planner가 포스팅 전략 수립 시 참조 자료로 사용한다.
 */

import { getAnthropicClient, MODELS } from "@/lib/anthropic/client";

export interface NaverContentFetcherInput {
  /** 수집할 블로그 글 URL 목록 (최대 5개) */
  urls: string[];
  /** 원본 키워드 (요약 컨텍스트용) */
  keyword: string;
}

export interface FetchedArticle {
  url: string;
  title: string;
  bodyText: string;
  charCount: number;
  ok: boolean;
  error?: string;
}

export interface NaverContentFetcherOutput {
  keyword: string;
  articles: FetchedArticle[];
  /** Claude가 생성한 핵심 내용 요약 */
  researchSummary: string;
  successCount: number;
  error?: string;
}

const FETCH_TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 3_000;

// ── HTML → 순수 텍스트 ───────────────────────────────────

function htmlToText(html: string): string {
  // script / style 제거
  let s = html.replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ");

  // 네이버 블로그 본문 영역 우선 추출
  const selectors = [
    /<div[^>]+class="[^"]*se-main-container[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+id="postViewArea"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]+class="[^"]*post-view[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<article[^>]*>([\s\S]*?)<\/article>/i,
  ];
  for (const re of selectors) {
    const m = s.match(re);
    if (m?.[1] && m[1].length > 300) {
      s = m[1];
      break;
    }
  }

  s = s.replace(/<\/(p|div|h[1-6]|li|br)[^>]*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");

  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(parseInt(n, 10)));

  s = s.replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim().replace(/\s*[-:|].*$/, "").trim().slice(0, 100) : "";
}

// 네이버 블로그 URL → 모바일 URL (본문 접근 용이)
function toMobileNaverUrl(url: string): string {
  if (url.includes("blog.naver.com") && !url.includes("m.blog.naver.com")) {
    return url.replace("blog.naver.com", "m.blog.naver.com");
  }
  return url;
}

async function fetchOne(url: string): Promise<FetchedArticle> {
  const targetUrl = toMobileNaverUrl(url);
  try {
    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; BlogAutomation/1.0; +research)",
        Accept: "text/html,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });

    if (!res.ok) {
      return { url, title: "", bodyText: "", charCount: 0, ok: false, error: `HTTP ${res.status}` };
    }

    const html = await res.text();
    const title = extractTitle(html);
    const bodyText = htmlToText(html).slice(0, MAX_BODY_CHARS);

    if (bodyText.length < 100) {
      return { url, title, bodyText: "", charCount: 0, ok: false, error: "본문 너무 짧음" };
    }

    return { url, title, bodyText, charCount: bodyText.length, ok: true };
  } catch (err) {
    return {
      url, title: "", bodyText: "", charCount: 0, ok: false,
      error: err instanceof Error ? err.message : "fetch 실패",
    };
  }
}

// ── AI 요약 ──────────────────────────────────────────────

async function summarizeArticles(
  keyword: string,
  articles: FetchedArticle[]
): Promise<string> {
  const successArticles = articles.filter((a) => a.ok);
  if (successArticles.length === 0) return "수집된 본문이 없어 요약을 생성할 수 없습니다.";

  const articlesText = successArticles
    .map(
      (a, i) =>
        `[글 ${i + 1}] ${a.title}\n출처: ${a.url}\n\n${a.bodyText}`
    )
    .join("\n\n---\n\n");

  const client = getAnthropicClient();
  const response = await client.messages.create(
    {
      model: MODELS.haiku,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `다음은 네이버 블로그에서 "**${keyword}**" 키워드로 검색한 상위 글들입니다.

${articlesText}

---

위 글들을 분석해서 다음 형식으로 요약해주세요:

## 상위 글 핵심 내용 요약

### 공통으로 다루는 주제
- (3~5개)

### 독자들이 궁금해하는 포인트
- (3~5개)

### 기존 글에서 아쉬운 점 / 우리가 차별화할 수 있는 각도
- (2~3개)

### 자주 등장하는 키워드/표현
- (5~10개)

간결하게 핵심만 정리해주세요.`,
        },
      ],
    },
    { signal: AbortSignal.timeout(30_000) }
  );

  const text = response.content.find((b) => b.type === "text");
  return text?.type === "text" ? text.text : "요약 생성 실패";
}

// ── 메인 ─────────────────────────────────────────────────

export async function naverContentFetcher(
  input: NaverContentFetcherInput
): Promise<NaverContentFetcherOutput> {
  const { urls, keyword } = input;
  const targets = urls.slice(0, 5); // 최대 5개

  try {
    const articles = await Promise.all(targets.map(fetchOne));
    const successCount = articles.filter((a) => a.ok).length;
    const researchSummary = await summarizeArticles(keyword, articles);

    return { keyword, articles, researchSummary, successCount };
  } catch (err) {
    return {
      keyword,
      articles: [],
      researchSummary: "",
      successCount: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
