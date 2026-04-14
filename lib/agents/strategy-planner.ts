import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { getAnthropicClient, MODELS } from "@/lib/anthropic/client";
import { runToolUseLoop } from "@/lib/anthropic/tool-executor";
import { userProfileLoader } from "@/lib/skills/user-profile-loader";
import { userCorpusRetriever } from "@/lib/skills/user-corpus-retriever";
import { topicFeasibilityJudge } from "@/lib/skills/topic-feasibility-judge";
import { sourceResolver } from "@/lib/skills/source-resolver";
import { reviewRecordAudit } from "@/lib/skills/review-record-audit";
import { naverKeywordResearch } from "@/lib/skills/naver-keyword-research";
import { naverContentFetcher } from "@/lib/skills/naver-content-fetcher";
import { readJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { Topic } from "@/lib/types/github-data";
import type { TopicIndex } from "@/lib/types/github-data";
import type { StrategyPlanResult } from "./types";

const SYSTEM_PROMPT = `당신은 네이버 블로그 포스팅 전략 전문가입니다.
주어진 토픽을 분석하여 사용자의 글쓰기 스타일과 타깃 독자에 맞는 포스팅 전략을 수립합니다.

## 작업 순서
1. user_profile_loader로 사용자 프로필과 금지 표현 로드
2. user_corpus_retriever로 관련 예시 글 2개 로드 (스타일 분석, limit:2)
3. topic_feasibility_judge로 토픽 실현 가능성 확인
4. naver_keyword_research로 키워드 경쟁도 및 연관 키워드 조사
5. naver_content_fetcher로 상위 블로그 글 본문 수집 및 핵심 내용 파악
6. (참조 URL이 있으면) source_resolver로 검증
7. review_record_audit으로 과거 패턴 참조
8. 위 정보를 종합하여 전략 JSON 출력 — 특히 naver_content_fetcher 요약을 바탕으로 기존 글과 차별화된 각도를 전략에 반영할 것

## 출력 형식 (반드시 JSON 코드블록)
\`\`\`json
{
  "title": "포스팅 제목 (50자 이내, 검색 의도 반영)",
  "outline": [
    {
      "heading": "섹션 제목",
      "subPoints": ["하위 포인트"],
      "contentDirection": "작성 방향",
      "estimatedParagraphs": 2
    }
  ],
  "keyPoints": ["핵심 메시지"],
  "estimatedLength": 1500,
  "tone": "friendly",
  "keywords": ["키워드1", "키워드2"],
  "suggestedSources": [],
  "rationale": "전략 근거"
}
\`\`\`

## 금지 항목 처리 원칙
- 가격 정보 언급 금지: 특정 제품/서비스의 가격, 할인가, 원가, 금액 비교 등 일체 포함하지 않는다
- 이벤트/프로모션 언급 금지: 할인 행사, 기간 한정 이벤트, 쿠폰, 적립금, 무료 증정 등 일체 포함하지 않는다
- 위 두 항목은 아웃라인, 키포인트, 제목, 전략 근거 어디에도 포함되어서는 안 된다

**⚠️ 중요: 금지 항목 때문에 전략 출력을 거부하지 않는다.**
토픽 제목이 금지 항목과 관련되어 보여도 반드시 전략 JSON을 출력한다.
금지된 내용(예: 가격 비교)은 해당 섹션을 제외하거나 허용된 각도(기능·사용감·특징 비교 등)로
재구성하여 진행한다. 전략 출력 거부는 어떤 경우에도 허용되지 않는다.

## 주의사항
- 금지 표현은 절대 포함하지 않는다
- 코퍼스 예시의 글쓰기 스타일을 반영한다
- 타깃 독자 수준에 맞는 깊이를 유지한다`;

const TOOLS: Tool[] = [
  {
    name: "user_profile_loader",
    description: "사용자 프로필과 금지 표현 목록을 GitHub에서 로드합니다.",
    input_schema: {
      type: "object" as const,
      properties: {
        userId: { type: "string", description: "사용자 ID" },
      },
      required: ["userId"],
    },
  },
  {
    name: "user_corpus_retriever",
    description: "사용자 예시 글 코퍼스를 GitHub에서 로드합니다.",
    input_schema: {
      type: "object" as const,
      properties: {
        userId: { type: "string" },
        limit: { type: "number", description: "로드할 샘플 수 (기본 5)" },
        category: { type: "string", description: "카테고리 필터" },
      },
      required: ["userId"],
    },
  },
  {
    name: "topic_feasibility_judge",
    description: "토픽의 실현 가능성을 판단합니다.",
    input_schema: {
      type: "object" as const,
      properties: {
        topic: { type: "object", description: "Topic 객체" },
        userProfile: { type: "object", description: "UserProfile 객체" },
        forbiddenExpressions: { type: "object", description: "ForbiddenExpressions 객체" },
      },
      required: ["topic", "userProfile", "forbiddenExpressions"],
    },
  },
  {
    name: "source_resolver",
    description: "참조 URL의 유효성을 확인하고 제목/요약을 추출합니다.",
    input_schema: {
      type: "object" as const,
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "확인할 URL 목록" },
      },
      required: ["urls"],
    },
  },
  {
    name: "review_record_audit",
    description: "사용자의 과거 포스팅 패턴을 분석합니다.",
    input_schema: {
      type: "object" as const,
      properties: {
        userId: { type: "string" },
        limit: { type: "number", description: "최근 N개 포스팅 (기본 10)" },
      },
      required: ["userId"],
    },
  },
  {
    name: "naver_keyword_research",
    description:
      "네이버 블로그 검색 API로 키워드 경쟁도, 연관 키워드, 롱테일 제안, 상위 글 목록을 조회합니다.",
    input_schema: {
      type: "object" as const,
      properties: {
        keyword: { type: "string", description: "조사할 키워드 (토픽 제목 또는 핵심 키워드)" },
        display: { type: "number", description: "수집할 블로그 글 수 (기본 30)" },
      },
      required: ["keyword"],
    },
  },
  {
    name: "naver_content_fetcher",
    description:
      "네이버 상위 블로그 글 URL 목록을 받아 실제 본문을 수집하고 AI로 핵심 내용을 요약합니다. naver_keyword_research의 topItems[].link 값을 urls로 전달하세요.",
    input_schema: {
      type: "object" as const,
      properties: {
        urls: {
          type: "array",
          items: { type: "string" },
          description: "수집할 블로그 글 URL 목록 (최대 5개)",
        },
        keyword: { type: "string", description: "원본 키워드 (요약 컨텍스트용)" },
      },
      required: ["urls", "keyword"],
    },
  },
];

async function loadTopic(topicId: string): Promise<Topic> {
  const path = Paths.topicsIndex();
  if (!(await fileExists(path))) {
    throw new Error(`topics index 파일이 없습니다.`);
  }
  const { data } = await readJsonFile<TopicIndex>(path);
  const topic = data.topics.find((t) => t.topicId === topicId);
  if (!topic) throw new Error(`topicId "${topicId}"를 찾을 수 없습니다.`);
  return topic;
}

function parseStrategyFromText(text: string): StrategyPlanResult {
  // 1. ```json ... ``` 블록
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch?.[1]) {
    try { return JSON.parse(jsonMatch[1].trim()) as StrategyPlanResult; } catch { /* fallthrough */ }
  }

  // 2. ``` ... ``` (언어 명시 없는 코드블록)
  const codeMatch = text.match(/```\s*([\s\S]*?)```/);
  if (codeMatch?.[1]) {
    try { return JSON.parse(codeMatch[1].trim()) as StrategyPlanResult; } catch { /* fallthrough */ }
  }

  // 3. 가장 큰 { } 블록 추출 (중첩 고려)
  let depth = 0, start = -1, best = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") { if (depth === 0) start = i; depth++; }
    else if (text[i] === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        const candidate = text.slice(start, i + 1);
        if (candidate.length > best.length) best = candidate;
      }
    }
  }
  if (best) {
    try { return JSON.parse(best) as StrategyPlanResult; } catch { /* fallthrough */ }
  }

  // 파싱 실패 — 디버그용으로 원문 앞 500자 포함
  const preview = text.slice(0, 500).replace(/\n/g, " ");
  throw new Error(`strategy-planner JSON 파싱 실패. 응답 미리보기: ${preview}`);
}

export async function runStrategyPlanner(params: {
  topicId: string;
  userId: string;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<StrategyPlanResult> {
  const { topicId, userId, onProgress, signal } = params;

  onProgress?.(`토픽 "${topicId}" 전략 수립 시작`);

  const topic = await loadTopic(topicId);

  const toolRegistry = {
    user_profile_loader: (input: unknown) =>
      userProfileLoader(input as Parameters<typeof userProfileLoader>[0]),
    user_corpus_retriever: (input: unknown) =>
      userCorpusRetriever(input as Parameters<typeof userCorpusRetriever>[0]),
    topic_feasibility_judge: (input: unknown) => {
      const i = input as Parameters<typeof topicFeasibilityJudge>[0];
      return Promise.resolve(topicFeasibilityJudge(i));
    },
    source_resolver: (input: unknown) =>
      sourceResolver(input as Parameters<typeof sourceResolver>[0]),
    review_record_audit: (input: unknown) =>
      reviewRecordAudit(input as Parameters<typeof reviewRecordAudit>[0]),
    naver_keyword_research: (input: unknown) =>
      naverKeywordResearch(input as Parameters<typeof naverKeywordResearch>[0]),
    naver_content_fetcher: (input: unknown) =>
      naverContentFetcher(input as Parameters<typeof naverContentFetcher>[0]),
  };

  const userMessage = `다음 토픽으로 포스팅 전략을 수립해주세요.

토픽 ID: ${topicId}
제목: ${topic.title}
설명: ${topic.description}
카테고리: ${topic.category}
태그: ${topic.tags.join(", ")}
담당 사용자 ID: ${userId}
참조 URL: ${topic.relatedSources.join(", ") || "없음"}

위 도구들을 순서대로 사용하여 최적의 전략을 수립한 후, 전략 JSON을 출력해주세요.`;

  onProgress?.("strategy-planner 에이전트 실행 중...");

  let plan: StrategyPlanResult;
  try {
    const result = await runToolUseLoop({
      model: MODELS.sonnet,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
      tools: TOOLS,
      toolRegistry,
      maxIterations: 6,
      onProgress,
      signal,
    });

    onProgress?.("전략 계획 파싱 중...");
    plan = parseStrategyFromText(result);
    if (!plan.title || typeof plan.title !== "string") {
      throw new Error("전략 파싱 실패: title 필드 없음 — 폴백 시도");
    }
  } catch (loopOrParseErr) {
    // pipeline signal이 이미 abort됐으면 폴백 없이 즉시 throw
    if (signal?.aborted) {
      throw new Error("파이프라인 취소 — 전략 수립 중단");
    }
    // tool-use 루프 오류 또는 파싱 실패 → 직접 호출 폴백
    console.warn("[strategy-planner] tool-use 루프/파싱 실패, simple 폴백 시도:", String(loopOrParseErr));
    onProgress?.("전략 파싱 재시도 중 (direct 모드)...");
    plan = await runStrategyPlannerSimple({
      topicTitle: topic.title,
      topicDescription: topic.description,
      userId,
      signal,
    });
    if (!plan.title || typeof plan.title !== "string") {
      throw new Error(`전략 수립 최종 실패: 폴백 응답에도 title 없음 (topicId=${topicId})`);
    }
  }

  onProgress?.(`전략 수립 완료: "${plan.title}"`);
  return plan;
}

// 단순 Claude 호출로 전략 수립 (도구 없이 — 테스트/폴백용)
export async function runStrategyPlannerSimple(params: {
  topicTitle: string;
  topicDescription: string;
  userId: string;
  signal?: AbortSignal;
}): Promise<StrategyPlanResult> {
  const client = getAnthropicClient();

  const CALL_TIMEOUT_MS = 45_000;
  const callSignal = params.signal
    ? AbortSignal.any([AbortSignal.timeout(CALL_TIMEOUT_MS), params.signal])
    : AbortSignal.timeout(CALL_TIMEOUT_MS);

  const response = await client.messages.create({
    model: MODELS.sonnet,
    system: SYSTEM_PROMPT,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `토픽 제목: ${params.topicTitle}\n설명: ${params.topicDescription}\n사용자 ID: ${params.userId}\n\n전략 JSON을 출력해주세요.`,
      },
    ],
  }, { signal: callSignal });

  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("응답 없음");
  return parseStrategyFromText(text.text);
}
