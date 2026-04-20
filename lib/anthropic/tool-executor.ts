import type {
  MessageParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { getAnthropicClient } from "./client";
import { anthropicSemaphore } from "./semaphore";
import type { ToolUseLoopOptions } from "@/lib/types/agent";

const DEFAULT_MAX_ITERATIONS = 10;

/**
 * Anthropic SDK tool-use 루프 실행기
 *
 * - 스트리밍 모드 사용 → 첫 토큰까지의 지연과 스톨을 분리해 감지
 * - 타이머는 **세마포어 획득 후**에만 동작 — 큐 대기 시간이 타임아웃에 포함되지
 *   않도록 함 (동시 접속 오탐 방지, master-writer와 동일 패턴)
 * - end_turn 도달 시 최종 텍스트 반환, tool_use 시 스킬 실행 후 재호출
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

  // INITIAL: 첫 이벤트 수신 전 허용 지연 (Anthropic이 큐잉 후 첫 토큰까지)
  // STALL: 첫 이벤트 수신 후 연속 무응답 허용 시간
  const INITIAL_TIMEOUT_MS = 150_000;
  const STALL_TIMEOUT_MS = 90_000;
  // hard deadline: stall 타이머 실패 시 HTTP 연결 수준 백업
  const HARD_DEADLINE_MS = 160_000;

  while (iterations < maxIterations) {
    iterations++;
    if (pipelineSignal?.aborted) {
      throw new Error("파이프라인이 중단되었습니다.");
    }

    const sem = anthropicSemaphore.stats;
    onProgress?.(`AI 분석 중... (${iterations}/${maxIterations})`);
    console.log(
      `[tool-executor] iteration ${iterations} pre-acquire — semaphore: running=${sem.running}/${sem.max}, queued=${sem.queued}`
    );

    let finalText = "";
    let finalStopReason: string | null = null;
    const toolUseBlocks: Array<{
      id: string;
      name: string;
      input: Record<string, unknown>;
    }> = [];
    let finalContent: import("@anthropic-ai/sdk/resources/messages").ContentBlock[] =
      [];

    try {
      await anthropicSemaphore.runWithRetry(
        async () => {
          // ↓ 세마포어 획득 후에만 타이머 시작 (대기 시간 제외)
          let stallTimer: ReturnType<typeof setTimeout> | null = null;
          let stallReject: ((err: Error) => void) | null = null;
          let firstEventReceived = false;

          const resetStallTimer = () => {
            if (stallTimer) clearTimeout(stallTimer);
            if (!stallReject) return;
            const ms = firstEventReceived ? STALL_TIMEOUT_MS : INITIAL_TIMEOUT_MS;
            stallTimer = setTimeout(
              () =>
                stallReject!(
                  new Error(
                    firstEventReceived
                      ? `AI 응답 스트림 타임아웃 — ${ms / 1000}초 이상 토큰 없음 (iter=${iterations})`
                      : `AI 응답 초기 타임아웃 — ${ms / 1000}초 이내 첫 토큰 없음 (iter=${iterations})`
                  )
                ),
              ms
            );
          };

          const stallPromise = new Promise<never>((_, reject) => {
            stallReject = reject;
            resetStallTimer();
          });

          const hardDeadline = AbortSignal.timeout(HARD_DEADLINE_MS);
          const callSignal = pipelineSignal
            ? AbortSignal.any([pipelineSignal, hardDeadline])
            : hardDeadline;

          console.log(
            `[tool-executor] iteration ${iterations} stream start (post-acquire)`
          );

          try {
            await Promise.race([
              (async () => {
                const stream = client.messages.stream(
                  {
                    model,
                    system,
                    messages,
                    tools,
                    max_tokens: 4096,
                  },
                  { signal: callSignal }
                );

                for await (const event of stream) {
                  if (!firstEventReceived) firstEventReceived = true;
                  resetStallTimer();
                  // tool-use 루프에서는 토큰 자체를 UI로 흘리지 않음 (progress 메시지만 사용)
                  if (event.type === "message_stop") {
                    finalStopReason = "end_turn";
                  }
                }

                const finalMsg = await stream.finalMessage();
                finalStopReason = finalMsg.stop_reason ?? finalStopReason;
                finalContent = finalMsg.content;
                for (const block of finalMsg.content) {
                  if (block.type === "tool_use") {
                    toolUseBlocks.push({
                      id: block.id,
                      name: block.name,
                      input: block.input as Record<string, unknown>,
                    });
                  }
                  if (block.type === "text") {
                    finalText += block.text;
                  }
                }
              })(),
              stallPromise,
            ]);
          } finally {
            if (stallTimer) clearTimeout(stallTimer);
          }
        },
        (queuePos) => {
          onProgress?.(
            `동시 사용자가 많아 ${queuePos}번째로 대기 중... (잠시만 기다려주세요)`
          );
        }
      );
    } catch (err) {
      console.error("[tool-executor] Anthropic API 오류:", {
        name: err instanceof Error ? err.constructor.name : "UnknownError",
        message: err instanceof Error ? err.message : String(err),
        status: (err as { status?: number }).status,
        cause:
          err instanceof Error
            ? (err as { cause?: unknown }).cause
            : undefined,
        code: err instanceof Error ? (err as { code?: string }).code : undefined,
      });
      throw err;
    }

    console.log(
      `[tool-executor] iteration ${iterations} done — stopReason=${finalStopReason}, tools=${toolUseBlocks
        .map((b) => b.name)
        .join(",") || "none"}, textLen=${finalText.length}`
    );

    // 어시스턴트 응답을 메시지 히스토리에 추가 (원본 content 그대로)
    messages.push({ role: "assistant", content: finalContent });

    if (finalStopReason === "end_turn" && toolUseBlocks.length === 0) {
      return finalText;
    }

    if (toolUseBlocks.length > 0) {
      const skillLabel: Record<string, string> = {
        user_profile_loader: "사용자 프로필 로드",
        user_corpus_retriever: "코퍼스 분석",
        topic_feasibility_judge: "실현 가능성 검토",
        naver_keyword_research: "네이버 키워드 리서치",
        naver_content_fetcher: "상위 블로그 수집",
        review_record_audit: "과거 패턴 분석",
        source_resolver: "참조 URL 검증",
      };
      const SKILL_TIMEOUT_MS = 30_000;
      const toolResults: ToolResultBlockParam[] = [];

      for (const block of toolUseBlocks) {
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

        onProgress?.(`${skillLabel[block.name] ?? block.name} 중...`);
        console.log(`[tool-executor] skill "${block.name}" start`);
        try {
          const result = await Promise.race([
            skillFn(block.input),
            new Promise<never>((_, reject) =>
              setTimeout(
                () =>
                  reject(
                    new Error(
                      `스킬 타임아웃 "${block.name}" (${SKILL_TIMEOUT_MS / 1000}초)`
                    )
                  ),
                SKILL_TIMEOUT_MS
              )
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

    // max_tokens 등 기타 stop_reason
    break;
  }

  throw new Error(`tool-use 루프가 ${maxIterations}회 반복 한계에 도달했습니다.`);
}
