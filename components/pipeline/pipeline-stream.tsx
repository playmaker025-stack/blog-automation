"use client";

import { useEffect, useRef } from "react";
import type { SSEEvent } from "@/lib/agents/types";

interface Props {
  events: SSEEvent[];
  streamingBody: string;
}

export function PipelineStream({ events, streamingBody }: Props) {
  const logRef = useRef<HTMLDivElement>(null);

  // 새 이벤트 시 자동 스크롤
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [events, streamingBody]);

  const progressEvents = events.filter(
    (e) => e.type === "stage_change" || e.type === "progress" || e.type === "error"
  );

  return (
    <div className="space-y-3">
      {/* 진행 로그 */}
      <div
        ref={logRef}
        className="bg-zinc-950 rounded-lg p-4 h-40 overflow-y-auto font-mono text-xs"
      >
        {progressEvents.length === 0 ? (
          <p className="text-zinc-600">파이프라인 실행 대기 중...</p>
        ) : (
          progressEvents.map((e, i) => {
            const data = e.data as Record<string, unknown>;
            const msg = (data?.message as string) ?? e.type;
            const color =
              e.type === "error"
                ? "text-red-400"
                : e.type === "stage_change"
                ? "text-blue-400"
                : "text-zinc-400";
            return (
              <p key={i} className={color}>
                <span className="text-zinc-600">
                  {new Date(e.timestamp).toLocaleTimeString("ko-KR")}
                </span>{" "}
                {msg}
              </p>
            );
          })
        )}
      </div>

      {/* 스트리밍 본문 */}
      {streamingBody && (
        <div className="border border-zinc-200 rounded-lg">
          <div className="px-4 py-2 border-b border-zinc-100 flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
            <p className="text-xs text-zinc-500 font-medium">본문 생성 중...</p>
          </div>
          <div className="px-4 py-3 max-h-64 overflow-y-auto bg-zinc-950 rounded-b-lg">
            <pre className="text-sm text-white whitespace-pre-wrap font-sans leading-relaxed">
              {streamingBody}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}
