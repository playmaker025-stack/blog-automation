import type { MessageParam, ToolResultBlockParam } from "@anthropic-ai/sdk/resources/messages";
import { getAnthropicClient } from "./client";
import type { ToolUseLoopOptions } from "@/lib/types/agent";

const DEFAULT_MAX_ITERATIONS = 10;

/**
 * Anthropic SDK tool-use 루프 실행기
 *
 * - 에이전트가 tool_use 응답을 보내면 해당 스킬을 실행
 * - 결과를 메시지에 추가하고 다시 에이전트 호출
 * - end_turn 도달 시 최종 텍스트 반환
 */
export async function runToolUseLoop(
  options: ToolUseLoopOptions
): Promise<string> {
  const {
    model,
    system,
    tools,
    toolRegistry,
    maxIterations = DEFAULT_MAX_ITERATIONS,
    onProgress,
    signal: pipelineSignal,
  } = options;

  const client = getAnthropicClient();
  const messages: MessageParam[] = [...options.messages];
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    let response: Awaited<ReturnType<typeof client.messages.create>>;
    // 90s per call — 전략 합성·평가 JSON 생성 호출이 80s 이상 걸릴 수 있음
    // strategy route: 이터레이션 1-3 ~24s + 합성 ~90s = ~114s → route 한도 160s 이내
    // evaluator: 도구 호출 ~10s + 평가 JSON ~90s = ~100s → write route 240s 이내
    const CALL_TIMEOUT_MS = 90_000;
    try {
      // AbortSignal.any: 파이프라인 취소 신호 또는 per-call 타임아웃 중 먼저 발생하는 쪽으로 취소
      const callTimeoutSignal = AbortSignal.timeout(CALL_TIMEOUT_MS);
      const callSignal = pipelineSignal
        ? AbortSignal.any([callTimeoutSignal, pipelineSignal])
        : callTimeoutSignal;

      onProgress?.(`AI 분석 중... (${iterations}/${maxIterations})`);
      console.log(`[tool-executor] iteration ${iterations} API call start`);
      response = await client.messages.create({
        model,
        system,
        messages,
        tools,
        max_tokens: 4096,
      }, { signal: callSignal });
      console.log(`[tool-executor] iteration ${iterations} API call done — stop_reason=${response.stop_reason}`);
    } catch (err) {
      // 원본 오류 상세 정보를 서버 로그에 기록
      console.error("[tool-executor] Anthropic API 오류:", {
        name: err instanceof Error ? err.constructor.name : "UnknownError",
        message: err instanceof Error ? err.message : String(err),
        status: (err as { status?: number }).status,
        cause: err instanceof Error ? (err as { cause?: unknown }).cause : undefined,
        code: err instanceof Error ? (err as { code?: string }).code : undefined,
      });
      throw err;
    }

    // 어시스턴트 응답을 메시지 히스토리에 추가
    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      // 최종 텍스트 추출
      const textBlock = response.content.find((b) => b.type === "text");
      return textBlock && "text" in textBlock ? textBlock.text : "";
    }

    if (response.stop_reason === "tool_use") {
      const toolResults: ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        const skillFn = toolRegistry[block.name];
        if (!skillFn) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            is_error: true,
            content: `알 수 없는 도구: "${block.name}"`,
          });
          continue;
        }

        try {
          // 스킬 실행 타임아웃: GitHub API 등 외부 IO가 무한 대기하는 것 방지
          const SKILL_TIMEOUT_MS = 30_000;
          const skillLabel: Record<string, string> = {
            user_profile_loader: "사용자 프로필 로드",
            user_corpus_retriever: "코퍼스 분석",
            topic_feasibility_judge: "실현 가능성 검토",
            naver_keyword_research: "네이버 키워드 리서치",
            naver_content_fetcher: "상위 블로그 수집",
            review_record_audit: "과거 패턴 분석",
            source_resolver: "참조 URL 검증",
          };
          onProgress?.(`${skillLabel[block.name] ?? block.name} 중...`);
          console.log(`[tool-executor] skill "${block.name}" start`);
          const result = await Promise.race([
            skillFn(block.input),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`스킬 타임아웃 "${block.name}" (${SKILL_TIMEOUT_MS / 1000}초)`)), SKILL_TIMEOUT_MS)
            ),
          ]);
          console.log(`[tool-executor] skill "${block.name}" done`);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(result),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "스킬 실행 오류";
          console.error(`[tool-executor] skill "${block.name}" error:`, message);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            is_error: true,
            content: message,
          });
        }
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // max_tokens 등 다른 stop_reason
    break;
  }

  throw new Error(`tool-use 루프가 ${maxIterations}회 반복 한계에 도달했습니다.`);
}
