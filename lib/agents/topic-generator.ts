/**
 * AI 글목록 자동 생성 에이전트
 *
 * 사용자의 기존 발행 글 목록을 분석하고,
 * 연관성 있는 신규 토픽 5개를 생성해 GitHub posting-list에 추가한다.
 *
 * 트리거 조건: 해당 사용자의 모든 토픽이 published 상태일 때
 */

import { getAnthropicClient, MODELS } from "@/lib/anthropic/client";
import { naverKeywordResearch } from "@/lib/skills/naver-keyword-research";
import type { Topic } from "@/lib/types/github-data";

export interface TopicGeneratorInput {
  userId: string;
  publishedTopics: Topic[];
  onProgress?: (msg: string) => void;
}

export interface GeneratedTopic {
  title: string;
  description: string;
  category: string;
  tags: string[];
  rationale: string; // 왜 이 토픽을 추천했는지
}

export interface TopicGeneratorOutput {
  generatedTopics: GeneratedTopic[];
  researchKeyword: string;
  competitionInfo: string;
}

// 기존 토픽에서 대표 카테고리 추출
function extractMainCategory(topics: Topic[]): string {
  const counts = new Map<string, number>();
  for (const t of topics) {
    if (t.category) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
  }
  if (counts.size === 0) return "일반";
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// 기존 토픽에서 대표 키워드 추출 (가장 빈출 태그)
function extractRepresentativeKeyword(topics: Topic[]): string {
  const counts = new Map<string, number>();
  for (const t of topics) {
    for (const tag of t.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    // 제목 첫 단어도 후보로
    const firstWord = t.title.split(/\s+/)[0];
    if (firstWord.length >= 2) {
      counts.set(firstWord, (counts.get(firstWord) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return topics[0]?.title.split(" ")[0] ?? "블로그";
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function parseGeneratedTopics(text: string): GeneratedTopic[] {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  const raw = jsonMatch?.[1] ?? text;
  try {
    const parsed = JSON.parse(raw.trim()) as unknown;
    if (Array.isArray(parsed)) return parsed as GeneratedTopic[];
    const obj = parsed as { topics?: GeneratedTopic[] };
    if (obj.topics && Array.isArray(obj.topics)) return obj.topics;
  } catch {
    // JSON 파싱 실패 시 빈 배열
  }
  return [];
}

export async function runTopicGenerator(
  input: TopicGeneratorInput
): Promise<TopicGeneratorOutput> {
  const { userId, publishedTopics, onProgress } = input;

  onProgress?.(`${publishedTopics.length}개 기존 글 분석 중...`);

  // 대표 키워드로 네이버 리서치
  const representativeKeyword = extractRepresentativeKeyword(publishedTopics);
  const mainCategory = extractMainCategory(publishedTopics);

  onProgress?.(`네이버 키워드 리서치: "${representativeKeyword}"`);

  const research = await naverKeywordResearch({ keyword: representativeKeyword, display: 20 });

  const competitionInfo = research.error
    ? "네이버 리서치 불가 (API 오류)"
    : `경쟁도: ${research.blog.competition} (${research.blog.total.toLocaleString()}건) / 롱테일 제안: ${research.longtailSuggestions.slice(0, 3).join(", ")}`;

  onProgress?.("신규 토픽 5개 생성 중...");

  const publishedTitles = publishedTopics.map((t) => `- ${t.title}`).join("\n");
  const longtailHints = research.longtailSuggestions.slice(0, 5).join(", ");
  const relatedWords = research.relatedKeywords
    .slice(0, 8)
    .map((r) => r.word)
    .join(", ");

  const client = getAnthropicClient();
  const response = await client.messages.create(
    {
      model: MODELS.sonnet,
      max_tokens: 2048,
      messages: [
        {
          role: "user",
          content: `사용자(${userId})의 블로그 글 목록입니다.
이 목록을 참고해 다음에 쓸 신규 토픽 5개를 추천해주세요.

## 기존 글 목록
${publishedTitles}

## 주력 카테고리
${mainCategory}

## 네이버 리서치 결과 (키워드: "${representativeKeyword}")
- 경쟁도: ${research.blog.competition}
- 연관 키워드: ${relatedWords}
- 롱테일 제안: ${longtailHints}

## 요구사항
1. 기존 글과 **겹치지 않으면서** 연관성 있는 주제
2. 기존 글의 독자가 자연스럽게 관심 가질 방향
3. 네이버 검색 유입을 노릴 수 있는 키워드 포함
4. 카테고리는 "${mainCategory}" 계열 유지
5. 시리즈 확장(기존 글의 심화·후속·비교), 계절성 토픽, 독자 질문형 토픽 등 다양하게 혼합

## 출력 형식 (JSON 코드블록)
\`\`\`json
[
  {
    "title": "포스팅 제목 (50자 이내)",
    "description": "이 글에서 다룰 핵심 내용 (2~3문장)",
    "category": "${mainCategory}",
    "tags": ["태그1", "태그2", "태그3"],
    "rationale": "왜 이 토픽을 추천하는지 (기존 글과의 연관성, 검색 수요 등)"
  }
]
\`\`\`

반드시 5개를 출력하세요.`,
        },
      ],
    },
    { signal: AbortSignal.timeout(60_000) }
  );

  const text = response.content.find((b) => b.type === "text");
  const rawText = text?.type === "text" ? text.text : "";
  const generatedTopics = parseGeneratedTopics(rawText);

  onProgress?.(`신규 토픽 ${generatedTopics.length}개 생성 완료`);

  return { generatedTopics, researchKeyword: representativeKeyword, competitionInfo };
}
