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
      // AbortSignal 연결
      const signal = request.signal;

      runPipeline({ request: body, controller, signal }).catch((err) => {
        const encoder = new TextEncoder();
        const event = JSON.stringify({
          type: "error",
          stage: "failed",
          data: { message: err instanceof Error ? err.message : "파이프라인 오류" },
          timestamp: new Date().toISOString(),
        });
        controller.enqueue(encoder.encode(`data: ${event}\n\n`));
        controller.close();
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
