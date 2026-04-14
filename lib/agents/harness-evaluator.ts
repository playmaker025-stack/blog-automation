import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { MODELS } from "@/lib/anthropic/client";
import { runToolUseLoop } from "@/lib/anthropic/tool-executor";
import { userCorpusRetriever } from "@/lib/skills/user-corpus-retriever";
import { reviewRecordAudit } from "@/lib/skills/review-record-audit";
import { writeJsonFile, fileExists, readJsonFile } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import { randomUUID } from "crypto";
import type { EvalResult, StrategyPlanResult, WriterResult } from "./types";

const PASS_THRESHOLD = 70;

const SYSTEM_PROMPT = `당신은 네이버 블로그 콘텐츠 품질 평가 전문가입니다.

## 평가 차원 (각 0-100점)
- originality (0.25): 독창적 관점, 표절 없음, 고유한 인사이트
- style_match (0.30): 사용자 코퍼스 글쓰기 스타일 일치도
- structure (0.20): 논리적 흐름, 섹션 구성, 가독성
- engagement (0.15): 독자 관심 유도, 유용성
- forbidden_check (0.10): 금지 표현 미포함 여부 (포함 시 0점)

## 작업 순서
1. user_corpus_retriever로 예시 글 로드 (style_match 기준)
2. review_record_audit으로 과거 포스팅 패턴 확인
3. 각 차원별 점수와 근거 작성
4. 가중치 합산: (score * weight) 합계
5. 개선 권고사항 1-3개 제시

## 출력 형식 (반드시 JSON 코드블록)
\`\`\`json
{
  "scores": {
    "originality": 85,
    "style_match": 90,
    "structure": 78,
    "engagement": 82,
    "forbidden_check": 100
  },
  "aggregateScore": 87,
  "reasoning": {
    "originality": "근거",
    "style_match": "근거",
    "structure": "근거",
    "engagement": "근거",
    "forbidden_check": "금지 표현 없음"
  },
  "recommendations": ["권고사항 1", "권고사항 2"]
}
\`\`\``;

const TOOLS: Tool[] = [
  {
    name: "user_corpus_retriever",
    description: "사용자 예시 글 코퍼스를 로드합니다 (style_match 기준).",
    input_schema: {
      type: "object" as const,
      properties: {
        userId: { type: "string" },
        limit: { type: "number" },
      },
      required: ["userId"],
    },
  },
  {
    name: "review_record_audit",
    description: "과거 포스팅 패턴을 분석합니다.",
    input_schema: {
      type: "object" as const,
      properties: {
        userId: { type: "string" },
        limit: { type: "number" },
      },
      required: ["userId"],
    },
  },
];

const WEIGHTS = {
  originality: 0.25,
  style_match: 0.30,
  structure: 0.20,
  engagement: 0.15,
  forbidden_check: 0.10,
} as const;

function parseEvalFromText(text: string): Omit<EvalResult, "runId" | "pass"> {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch?.[1]) {
    try {
      return JSON.parse(jsonMatch[1]) as Omit<EvalResult, "runId" | "pass">;
    } catch {
      // fallthrough
    }
  }
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]) as Omit<EvalResult, "runId" | "pass">;
    } catch {
      // fallthrough
    }
  }
  // 파싱 실패 시 기본값 반환
  return {
    scores: { originality: 0, style_match: 0, structure: 0, engagement: 0, forbidden_check: 0 },
    aggregateScore: 0,
    reasoning: { error: "평가 결과 파싱 실패" },
    recommendations: ["평가를 다시 실행해주세요."],
  };
}

function computeAggregate(scores: EvalResult["scores"]): number {
  return Math.round(
    Object.entries(WEIGHTS).reduce(
      (sum, [dim, weight]) => sum + (scores[dim as keyof typeof WEIGHTS] ?? 0) * weight,
      0
    )
  );
}

export async function runHarnessEvaluator(params: {
  writerResult: WriterResult;
  strategy: StrategyPlanResult;
  userId: string;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<EvalResult> {
  const { writerResult, strategy, userId, onProgress, signal } = params;

  onProgress?.("Harness Evaluator 시작...");

  const toolRegistry = {
    user_corpus_retriever: (input: unknown) =>
      userCorpusRetriever(input as Parameters<typeof userCorpusRetriever>[0]),
    review_record_audit: (input: unknown) =>
      reviewRecordAudit(input as Parameters<typeof reviewRecordAudit>[0]),
  };

  const userMessage = `다음 블로그 본문을 평가해주세요.

제목: ${writerResult.title}
글자수: ${writerResult.wordCount}자
전략 톤: ${strategy.tone}
목표 키워드: ${strategy.keywords.join(", ")}
담당 사용자 ID: ${userId}

--- 본문 시작 ---
${writerResult.content.slice(0, 1500)}${writerResult.content.length > 1500 ? "\n...(이하 생략)..." : ""}
--- 본문 끝 ---

user_corpus_retriever로 코퍼스를 로드하고, review_record_audit으로 패턴을 확인한 후 평가 JSON을 출력해주세요.`;

  onProgress?.("평가 에이전트 실행 중...");

  const resultText = await runToolUseLoop({
    model: MODELS.sonnet,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
    tools: TOOLS,
    toolRegistry,
    maxIterations: 4,
    onProgress,
    signal,
  });

  onProgress?.("평가 결과 파싱 중...");
  const parsed = parseEvalFromText(resultText);

  // aggregateScore 재계산 (가중치 기준)
  const aggregateScore = computeAggregate(parsed.scores);

  const runId = `eval-${randomUUID().slice(0, 8)}`;
  const evalResult: EvalResult = {
    runId,
    scores: parsed.scores,
    aggregateScore,
    reasoning: parsed.reasoning,
    recommendations: parsed.recommendations,
    pass: aggregateScore >= PASS_THRESHOLD,
  };

  // GitHub에 eval run 저장
  await saveEvalRun(evalResult, writerResult.postId);

  onProgress?.(
    `평가 완료: ${aggregateScore}점 (${evalResult.pass ? "통과" : "미달"})`
  );

  return evalResult;
}

async function saveEvalRun(evalResult: EvalResult, postId: string): Promise<void> {
  const runPath = Paths.evalRun(evalResult.runId);
  const exists = await fileExists(runPath);
  if (exists) return;

  await writeJsonFile(
    runPath,
    { ...evalResult, postId, savedAt: new Date().toISOString() },
    `feat: eval run ${evalResult.runId} for post ${postId}`,
    null
  );
}

// 베이스라인과 비교하여 회귀 여부 확인
export async function compareWithBaseline(
  evalResult: EvalResult,
  caseId: string
): Promise<number | null> {
  try {
    const { data: baselines } = await readJsonFile<{
      results: Array<{ caseId: string; aggregateScore: number }>;
    }>(Paths.evalBaselines());
    const baseline = baselines.results.find((r) => r.caseId === caseId);
    if (!baseline) return null;
    return evalResult.aggregateScore - baseline.aggregateScore;
  } catch {
    return null;
  }
}
