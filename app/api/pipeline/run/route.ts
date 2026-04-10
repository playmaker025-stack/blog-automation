import "@anthropic-ai/sdk/shims/node";
import { NextRequest, NextResponse } from "next/server";
import { runPipeline } from "@/lib/agents/orchestrator";
import type { PipelineRunRequest } from "@/lib/agents/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5분

export async function POST(request: NextRequest) {
  let body: PipelineRunRequest;
  try {
    body = await request.json() as PipelineRunRequest;
  } catch {
    return NextResponse.json({ error: "요청 본문 파싱 실패" }, { status: 400 });
  }

  if (!body.topicId || !body.userId) {
    return NextResponse.json(
      { error: "topicId와 userId가 필요합니다." },
      { status: 400 }
    );
  }

  const stream = new ReadableStream({
    start(controller) {
      const signal = request.signal;
      const encoder = new TextEncoder();

      // Railway 30s 게이트웨이 타임아웃 방지 — 15초마다 SSE 주석 전송
      const keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* stream closed */ }
      }, 15_000);

      runPipeline({ request: body, controller, signal })
        .catch((err) => {
          const event = JSON.stringify({
            type: "error",
            stage: "failed",
            data: { message: err instanceof Error ? err.message : "파이프라인 오류" },
            timestamp: new Date().toISOString(),
          });
          try { controller.enqueue(encoder.encode(`data: ${event}\n\n`)); } catch { /* ignore */ }
        })
        .finally(() => {
          clearInterval(keepalive);
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
