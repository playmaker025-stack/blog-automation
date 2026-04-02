import type { StreamEvent, TextDeltaEvent, StageChangeEvent, CompleteEvent } from "@/lib/types/agent";

/**
 * SSE 이벤트를 ReadableStream으로 변환하는 헬퍼
 *
 * Next.js Route Handler에서 Response body로 사용:
 * return new Response(createSSEStream(generator), { headers: SSE_HEADERS })
 */
export function createSSEStream(
  generator: AsyncGenerator<StreamEvent>
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of generator) {
          const line = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(line));
        }
      } catch (err) {
        const errorEvent: StreamEvent = {
          type: "error",
          data: { message: err instanceof Error ? err.message : "스트림 오류" },
          timestamp: new Date().toISOString(),
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorEvent)}\n\n`));
      } finally {
        controller.close();
      }
    },
  });
}

export const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
} as const;

// ============================================================
// 이벤트 생성 헬퍼
// ============================================================

export function stageChangeEvent(
  stage: StageChangeEvent["stage"],
  message: string
): StreamEvent {
  const data: StageChangeEvent = { stage, message };
  return { type: "stage_change", data, timestamp: new Date().toISOString() };
}

export function textDeltaEvent(delta: string): StreamEvent {
  const data: TextDeltaEvent = { delta };
  return { type: "text_delta", data, timestamp: new Date().toISOString() };
}

export function completeEvent(
  sessionId: string,
  postId: string | null,
  evalScore: number | null
): StreamEvent {
  const data: CompleteEvent = { sessionId, postId, evalScore };
  return { type: "complete", data, timestamp: new Date().toISOString() };
}
