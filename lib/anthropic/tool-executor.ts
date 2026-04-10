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
  } = options;

  const client = getAnthropicClient();
  const messages: MessageParam[] = [...options.messages];
  let iterations = 0;

  while (iterations < maxIterations) {
    iterations++;

    let response: Awaited<ReturnType<typeof client.messages.create>>;
    const CALL_TIMEOUT_MS = 90_000;
    try {
      // AbortSignal.timeout: HTTP 연결 레벨에서 강제 취소
      // Promise.race + setTimeout 패턴은 타임아웃 후에도 HTTP 연결이 살아있어
      // 다중 파이프라인 동시 실행 시 자원 고갈이 발생할 수 있음
      const callSignal = AbortSignal.timeout(CALL_TIMEOUT_MS);
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
