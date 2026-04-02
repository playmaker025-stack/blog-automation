"use client";

import { useEffect, useRef, useState } from "react";
import type { SSEEvent } from "@/lib/agents/types";

interface UseSSEOptions {
  url: string | null;
  onEvent: (event: SSEEvent) => void;
  onError?: (error: Event) => void;
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
}

interface UseSSEResult {
  connected: boolean;
  close: () => void;
}

export function useSSE({
  url,
  onEvent,
  onError,
  autoReconnect = false,
  reconnectDelayMs = 3000,
}: UseSSEOptions): UseSSEResult {
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const closedRef = useRef(false);

  const close = () => {
    closedRef.current = true;
    esRef.current?.close();
    esRef.current = null;
    setConnected(false);
  };

  useEffect(() => {
    if (!url) return;
    closedRef.current = false;

    const connect = () => {
      if (closedRef.current) return;

      const es = new EventSource(url);
      esRef.current = es;

      es.onopen = () => setConnected(true);

      es.onmessage = (e: MessageEvent<string>) => {
        try {
          const event = JSON.parse(e.data) as SSEEvent;
          onEvent(event);

          // complete 또는 error 시 자동 종료
          if (event.type === "result" || event.type === "error") {
            close();
          }
        } catch {
          // JSON 파싱 실패 무시
        }
      };

      es.onerror = (e) => {
        setConnected(false);
        onError?.(e);
        es.close();
        esRef.current = null;

        if (autoReconnect && !closedRef.current) {
          setTimeout(connect, reconnectDelayMs);
        }
      };
    };

    connect();
    return () => {
      closedRef.current = true;
      esRef.current?.close();
      esRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  return { connected, close };
}
