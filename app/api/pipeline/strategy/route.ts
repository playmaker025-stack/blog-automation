import "@anthropic-ai/sdk/shims/node";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { runStrategyPhase } from "@/lib/agents/orchestrator";

export const dynamic = "force-dynamic";
export const maxDuration = 180; // 전략 수립 — 합성 호출이 70s까지 걸릴 수 있음

export async function POST(request: NextRequest) {
  let body: { topicId: string; userId: string };
  try {
    body = (await request.json()) as { topicId: string; userId: string };
  } catch {
    return NextResponse.json({ error: "요청 본문 파싱 실패" }, { status: 400 });
  }
  if (!body.topicId || !body.userId) {
    return NextResponse.json(
      { error: "topicId와 userId가 필요합니다." },
      { status: 400 }
    );
  }

  const pipelineId = `pipe-${randomUUID().slice(0, 8)}`;
  const abortController = new AbortController();

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();

      const keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* closed */ }
      }, 15_000);

      let closed = false;
      const timeout = setTimeout(() => {
        if (closed) return;
        abortController.abort(new Error("전략 수립 타임아웃 (160초)"));
        const event = JSON.stringify({
          type: "error",
          stage: "failed",
          data: { message: "전략 수립 타임아웃 (160초) — 자동 종료" },
          timestamp: new Date().toISOString(),
        });
        try { controller.enqueue(encoder.encode(`data: ${event}\n\n`)); } catch { /* ignore */ }
        try { controller.close(); } catch { /* ignore */ }
        closed = true;
      }, 160_000);

      runStrategyPhase({
        topicId: body.topicId,
        userId: body.userId,
        pipelineId,
        controller,
        signal: abortController.signal,
      })
        .catch((err) => {
          if (closed) return;
          const event = JSON.stringify({
            type: "error",
            stage: "failed",
            data: { message: err instanceof Error ? err.message : "전략 수립 오류" },
            timestamp: new Date().toISOString(),
          });
          try { controller.enqueue(encoder.encode(`data: ${event}\n\n`)); } catch { /* ignore */ }
        })
        .finally(() => {
          closed = true;
          clearTimeout(timeout);
          clearInterval(keepalive);
          abortController.abort();
          try { controller.close(); } catch { /* already closed */ }
        });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
