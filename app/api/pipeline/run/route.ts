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
      const encoder = new TextEncoder();

      // Railway 30s 게이트웨이 타임아웃 방지 — 15초마다 SSE 주석 전송
      const keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { /* stream closed */ }
      }, 15_000);

      // 글로벌 강제종료 타이머 — 240초 후 아무것도 완료 안 되면 강제 에러 종료
      // 개별 타임아웃(90s/160s)이 작동하지 않는 경우의 최후 보루
      let streamClosed = false;
      const globalTimeout = setTimeout(() => {
        if (streamClosed) return;
        console.error("[pipeline/run] global timeout 240s — force closing stream");
        const event = JSON.stringify({
          type: "error",
          stage: "failed",
          data: { message: "파이프라인 글로벌 타임아웃 (240초) — 자동 종료" },
          timestamp: new Date().toISOString(),
        });
        try { controller.enqueue(encoder.encode(`data: ${event}\n\n`)); } catch { /* ignore */ }
        try { controller.close(); } catch { /* ignore */ }
        streamClosed = true;
      }, 240_000);

      // request.signal을 파이프라인에 전달하지 않음 — SSE 클라이언트 연결 해제 시에도 파이프라인이 완료까지 실행되어야 함
      runPipeline({ request: body, controller })
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
          streamClosed = true;
          clearTimeout(globalTimeout);
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
