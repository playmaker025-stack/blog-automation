import "@anthropic-ai/sdk/shims/node";
import { NextRequest, NextResponse } from "next/server";
import { runWritePhase } from "@/lib/agents/orchestrator";
import type { StrategyPlanResult } from "@/lib/agents/types";

export const dynamic = "force-dynamic";
export const maxDuration = 250; // 글쓰기 + 평가 — Railway 300s 이내

export async function POST(request: NextRequest) {
  let body: {
    pipelineId: string;
    topicId: string;
    userId: string;
    strategy: StrategyPlanResult;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "요청 본문 파싱 실패" }, { status: 400 });
  }
  if (!body.topicId || !body.userId || !body.pipelineId || !body.strategy) {
    return NextResponse.json(
      { error: "topicId, userId, pipelineId, strategy가 필요합니다." },
      { status: 400 }
    );
  }

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
        abortController.abort(new Error("글쓰기 타임아웃 (240초)"));
        const event = JSON.stringify({
          type: "error",
          stage: "failed",
          data: { message: "글쓰기 타임아웃 (240초) — 자동 종료" },
          timestamp: new Date().toISOString(),
        });
        try { controller.enqueue(encoder.encode(`data: ${event}\n\n`)); } catch { /* ignore */ }
        try { controller.close(); } catch { /* ignore */ }
        closed = true;
      }, 240_000);

      runWritePhase({
        topicId: body.topicId,
        userId: body.userId,
        pipelineId: body.pipelineId,
        strategy: body.strategy,
        controller,
        signal: abortController.signal,
      })
        .catch((err) => {
          if (closed) return;
          const event = JSON.stringify({
            type: "error",
            stage: "failed",
            data: { message: err instanceof Error ? err.message : "글쓰기 오류" },
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
