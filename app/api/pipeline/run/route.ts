import "@anthropic-ai/sdk/shims/node";
import { NextRequest, NextResponse } from "next/server";
import { runPipeline } from "@/lib/agents/orchestrator";
import type { PipelineRunRequest } from "@/lib/agents/types";

export const dynamic = "force-dynamic";
export const maxDuration = 320; // 5분 20초 — Railway 300s + 여유

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

      // 파이프라인 수준 AbortController — 글로벌 타임아웃 시 Anthropic API 호출까지 취소
      const pipelineAbortController = new AbortController();

      // 글로벌 강제종료 타이머 — 280초 후 파이프라인 취소 + SSE 닫기
      // Railway 300s 제한보다 20s 낮게 설정
      let streamClosed = false;
      const globalTimeout = setTimeout(() => {
        if (streamClosed) return;
        console.error("[pipeline/run] global timeout 280s — aborting pipeline");
        pipelineAbortController.abort(new Error("파이프라인 글로벌 타임아웃 (280초)"));
        const event = JSON.stringify({
          type: "error",
          stage: "failed",
          data: { message: "파이프라인 글로벌 타임아웃 (280초) — 자동 종료" },
          timestamp: new Date().toISOString(),
        });
        try { controller.enqueue(encoder.encode(`data: ${event}\n\n`)); } catch { /* ignore */ }
        try { controller.close(); } catch { /* ignore */ }
        streamClosed = true;
      }, 280_000);

      runPipeline({ request: body, controller, signal: pipelineAbortController.signal })
        .catch((err) => {
          if (streamClosed) return; // 글로벌 타임아웃이 이미 처리
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
          pipelineAbortController.abort(); // 정상 완료 시에도 정리
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
