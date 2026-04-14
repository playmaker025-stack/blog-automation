import type { Tool } from "@anthropic-ai/sdk/resources/messages";
import { getAnthropicClient, MODELS } from "@/lib/anthropic/client";
import { userCorpusRetriever } from "@/lib/skills/user-corpus-retriever";
import { expansionPlanner } from "@/lib/skills/expansion-planner";
import { sourceResolver } from "@/lib/skills/source-resolver";
import { writeFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import { randomUUID } from "crypto";
import type { StrategyPlanResult, WriterResult } from "./types";
import type { CorpusSummaryArtifact } from "./corpus-selector";

// ============================================================
// 발행용 본문은 이 에이전트만 작성한다 — 핵심 원칙
// ============================================================

// 네이버 블로그 줄바꿈 규칙: 1줄 최대 25자
// 빈 줄, 구분선(---), 마크다운 헤더(#)만 유지, 나머지 전부 25자 래핑
function wrapTo25Chars(text: string): string {
  const MAX = 25;
  const lines = text.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trimStart();

    // 빈 줄 또는 구분선 → 그대로
    if (trimmed === "" || /^-{3,}$/.test(trimmed)) {
      result.push(line);
      continue;
    }

    // 마크다운 헤더(#) → 그대로 (구조적 포맷)
    if (trimmed.startsWith("#")) {
      result.push(line);
      continue;
    }

    // 25자 이하 → 그대로
    if (line.length <= MAX) {
      result.push(line);
      continue;
    }

    // 25자 초과 → 25자 단위로 줄바꿈
    let remaining = line;
    while (remaining.length > MAX) {
      result.push(remaining.slice(0, MAX));
      remaining = remaining.slice(MAX);
    }
    if (remaining) result.push(remaining);
  }

  return result.join("\n");
}

function buildCorpusSummarySection(corpus: CorpusSummaryArtifact): string {
  const { styleProfile, exemplarExcerpts } = corpus;
  return `
## 사용자 스타일 프로필 (corpus summary)
- 주요 어투: ${styleProfile.dominantTone}
- 평균 글자수: ${styleProfile.avgWordCount}자
- 서두 패턴: ${styleProfile.openingPattern}
- 구조 패턴: ${styleProfile.structurePattern}
- 시그니처 표현: ${styleProfile.signatureExpressions.join(", ") || "없음"}

## 예시 글 발췌 (${exemplarExcerpts.length}개)
${exemplarExcerpts
  .map(
    (e, i) =>
      `### 예시 ${i + 1}: ${e.title}\n스타일 메모: ${e.styleNotes}\n발췌: ${e.excerpt}`
  )
  .join("\n\n")}`;
}

const buildSystemPrompt = (userId: string, corpus: CorpusSummaryArtifact | null) => {
  const corpusSection =
    corpus
      ? buildCorpusSummarySection(corpus)
      : `사용자 "${userId}"의 예시 글을 user_corpus_retriever로 로드하여 스타일을 분석하세요.`;

  const step1 = corpus
    ? "1. 아래 코퍼스 summary를 바탕으로 스타일 분석 (별도 로드 불필요)"
    : `1. user_corpus_retriever로 사용자 "${userId}"의 예시 글 로드 후 스타일 분석`;

  return `당신은 네이버 블로그 본문 작성 전문가입니다.
이 에이전트만이 발행 가능한 본문을 작성할 수 있습니다.

## 작업 순서
${step1}
2. expansion_planner로 아웃라인 상세 확장
3. (필요 시) source_resolver로 참조 URL 내용 확인
4. 코퍼스 스타일을 완전히 재현한 한국어 본문 작성

## 글쓰기 원칙
- 코퍼스 스타일 완전 모방: 예시 글의 문체, 어투, 개인 표현 그대로 사용
- 한국어 전용: 영어 단어는 해당 한국어가 없을 때만 사용
- 금지 표현 절대 사용 금지
- 자연스러운 키워드 삽입 (억지 삽입 금지)
- 독자 관점에서 실제 유용한 내용 중심

## 출력 형식
전략에 따른 마크다운 본문 전체를 출력한다. 설명·메타 정보 없이 본문만 출력한다.

${corpusSection}`;
};

const CORPUS_TOOL: Tool = {
  name: "user_corpus_retriever",
  description: "사용자 예시 글 코퍼스를 로드합니다.",
  input_schema: {
    type: "object" as const,
    properties: {
      userId: { type: "string" },
      limit: { type: "number" },
      category: { type: "string" },
    },
    required: ["userId"],
  },
};

const BASE_TOOLS: Tool[] = [
  {
    name: "expansion_planner",
    description: "아웃라인을 받아 섹션별 상세 작성 방향을 계획합니다.",
    input_schema: {
      type: "object" as const,
      properties: {
        outline: { type: "array", description: "OutlineSection 배열" },
        targetLength: { type: "number", description: "목표 글자수" },
        tone: { type: "string" },
        keywords: { type: "array", items: { type: "string" } },
      },
      required: ["outline", "targetLength", "tone", "keywords"],
    },
  },
  {
    name: "source_resolver",
    description: "참조 URL 내용을 확인합니다.",
    input_schema: {
      type: "object" as const,
      properties: {
        urls: { type: "array", items: { type: "string" } },
      },
      required: ["urls"],
    },
  },
];

export async function runMasterWriter(params: {
  strategy: StrategyPlanResult;
  userId: string;
  topicId: string;
  corpusSummary?: CorpusSummaryArtifact;
  onToken?: (token: string) => void;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<WriterResult> {
  const { strategy, userId, topicId, corpusSummary, onToken, onProgress, signal } = params;

  onProgress?.(corpusSummary ? "Master Writer 시작 — corpus summary 적용 중..." : "Master Writer 시작 — 코퍼스 로드 중...");

  const client = getAnthropicClient();
  const TOOLS = corpusSummary ? BASE_TOOLS : [CORPUS_TOOL, ...BASE_TOOLS];
  const toolRegistry = {
    user_corpus_retriever: (input: unknown) =>
      userCorpusRetriever(input as Parameters<typeof userCorpusRetriever>[0]),
    expansion_planner: (input: unknown) => {
      const i = input as Parameters<typeof expansionPlanner>[0];
      return Promise.resolve(expansionPlanner(i));
    },
    source_resolver: (input: unknown) =>
      sourceResolver(input as Parameters<typeof sourceResolver>[0]),
  };

  const userMessage = `다음 전략에 따라 네이버 블로그 본문을 작성해주세요.

제목: ${strategy.title}
목표 글자수: ${strategy.estimatedLength}자
톤: ${strategy.tone}
키워드: ${strategy.keywords.join(", ")}
핵심 포인트: ${strategy.keyPoints.join(" / ")}

아웃라인:
${strategy.outline
  .map(
    (s, i) =>
      `${i + 1}. ${s.heading}\n   - ${s.subPoints.join("\n   - ")}\n   방향: ${s.contentDirection}`
  )
  .join("\n\n")}

${
    corpusSummary
      ? "시스템 프롬프트의 코퍼스 summary를 바탕으로 스타일을 분석한 후,"
      : `먼저 user_corpus_retriever로 사용자 "${userId}"의 예시 글을 로드하여 스타일을 분석한 후,`
  }
expansion_planner로 아웃라인을 확장하고, 본문을 마크다운으로 작성해주세요.`;

  // 1단계: tool-use loop (corpus retrieval + expansion planning)
  const messages: import("@anthropic-ai/sdk/resources/messages").MessageParam[] = [
    { role: "user", content: userMessage },
  ];

  let iterCount = 0;
  const maxIter = 4;

  while (iterCount < maxIter) {
    iterCount++;
    if (signal?.aborted) throw new Error("파이프라인이 중단되었습니다.");

    console.log(`[master-writer] iteration ${iterCount} start — messages=${messages.length}, topicId=${topicId}`);
    if (iterCount > 1) {
      onProgress?.(`본문 생성 중... (단계 ${iterCount})`);
    }

    // 스트리밍 모드로 API 호출 — 토큰 단위 수신으로 타임아웃 감지 신뢰성 향상
    // INITIAL: 첫 이벤트까지 150초 (블로그 본문 생성 시작이 느릴 수 있음)
    // STALL: 이후 연속 무응답 90초
    const INITIAL_TIMEOUT_MS = 150_000;
    const STALL_TIMEOUT_MS = 90_000;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let stallReject: ((err: Error) => void) | null = null;
    let firstEventReceived = false;

    const resetStallTimer = () => {
      if (stallTimer) clearTimeout(stallTimer);
      if (!stallReject) return;
      const ms = firstEventReceived ? STALL_TIMEOUT_MS : INITIAL_TIMEOUT_MS;
      stallTimer = setTimeout(
        () => stallReject!(new Error(firstEventReceived
          ? `Master Writer 스트림 타임아웃 — ${ms / 1000}초 이상 응답 없음 (iter=${iterCount})`
          : `Master Writer 초기 응답 타임아웃 — ${ms / 1000}초 이내 응답 없음 (iter=${iterCount})`)),
        ms
      );
    };

    const stallPromise = new Promise<never>((_, reject) => {
      stallReject = reject;
      resetStallTimer();
    });

    // AbortSignal: 외부 signal + 하드 데드라인(160초) 조합
    // stall timer(120/90초)의 백업 — HTTP 연결 수준에서도 강제 취소
    const hardDeadline = AbortSignal.timeout(160_000);
    const callSignal = signal
      ? AbortSignal.any([signal, hardDeadline])
      : hardDeadline;

    let rawText = "";
    let finalStopReason: string | null = null;
    const toolUseBlocks: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

    try {
      await Promise.race([
        (async () => {
          const stream = client.messages.stream({
            model: MODELS.sonnet,
            system: buildSystemPrompt(userId, corpusSummary ?? null),
            messages,
            tools: TOOLS,
            max_tokens: 4096,
          }, { signal: callSignal });

          for await (const event of stream) {
            if (!firstEventReceived) { firstEventReceived = true; }
            resetStallTimer();
            if (event.type === "content_block_delta") {
              if (event.delta.type === "text_delta") {
                rawText += event.delta.text;
                onToken?.(event.delta.text);
              }
            } else if (event.type === "message_stop") {
              finalStopReason = "end_turn"; // stream 완료
            }
          }

          // 최종 메시지에서 tool_use 블록 추출
          const finalMsg = await stream.finalMessage();
          finalStopReason = finalMsg.stop_reason ?? "end_turn";
          for (const block of finalMsg.content) {
            if (block.type === "tool_use") {
              toolUseBlocks.push({
                id: block.id,
                name: block.name,
                input: block.input as Record<string, unknown>,
              });
            }
            if (block.type === "text" && !rawText) {
              rawText = block.text;
            }
          }
          messages.push({ role: "assistant", content: finalMsg.content });
        })(),
        stallPromise,
      ]);
    } finally {
      if (stallTimer) clearTimeout(stallTimer);
    }

    console.log(`[master-writer] iteration ${iterCount} done — stopReason=${finalStopReason}, tools=${toolUseBlocks.map((b) => b.name).join(",") || "none"}, textLen=${rawText.length}`);

    if (finalStopReason === "end_turn" && toolUseBlocks.length === 0) {
      // 본문 생성 완료
      const bodyText = wrapTo25Chars(rawText);
      onProgress?.("본문 생성 완료 — GitHub에 저장 중...");
      return await saveWriterResult({ topicId, title: strategy.title, content: bodyText });
    }

    if (toolUseBlocks.length > 0) {
      const toolLabels: Record<string, string> = {
        user_corpus_retriever: "코퍼스 로드 중...",
        expansion_planner: "아웃라인 확장 중...",
        source_resolver: "참조 URL 확인 중...",
      };
      const toolResults: import("@anthropic-ai/sdk/resources/messages").ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
        onProgress?.(toolLabels[block.name] ?? `${block.name} 실행 중...`);
        const fn = toolRegistry[block.name as keyof typeof toolRegistry];
        if (!fn) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: `알 수 없는 도구: ${block.name}` });
          continue;
        }
        try {
          const result = await fn(block.input);
          toolResults.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) });
        } catch (err) {
          toolResults.push({ type: "tool_result", tool_use_id: block.id, is_error: true, content: String(err) });
        }
      }
      onProgress?.(`본문 생성 중... (단계 ${iterCount + 1})`);
      messages.push({ role: "user", content: toolResults });
      continue;
    }
    break;
  }

  throw new Error(`Master Writer가 ${maxIter}회 반복 한계에 도달했습니다.`);
}

async function saveWriterResult(params: {
  topicId: string;
  title: string;
  content: string;
}): Promise<WriterResult> {
  const postId = `post-${randomUUID().slice(0, 8)}`;
  const contentPath = Paths.postContent(postId);
  const wordCount = params.content.replace(/\s+/g, "").length;
  const generatedAt = new Date().toISOString();

  // GitHub에 본문 저장 (파일이 없을 때만 — sha null)
  const exists = await fileExists(contentPath);
  if (!exists) {
    await writeFile(
      contentPath,
      params.content,
      `feat: master-writer generated post ${postId}`,
      null
    );
  }

  return {
    postId,
    title: params.title,
    content: params.content,
    wordCount,
    generatedAt,
  };
}
