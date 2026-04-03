"use client";

import type { SSEEvent } from "@/lib/agents/types";

// ── Inspector가 추적하는 상태 ────────────────────────────────
export interface InspectorState {
  selected_topic: string | null;
  remaining_topics_count: number | null;
  strategy_plan_created: boolean;
  approval_required_emitted: boolean;
  approval_received: boolean | null; // null=미응답, true=승인, false=거절
  pre_write_gate_result: "pass" | "blocked" | null;
  draft_output_created: boolean;
  blocking_reason: string | null;
}

export const INITIAL_INSPECTOR_STATE: InspectorState = {
  selected_topic: null,
  remaining_topics_count: null,
  strategy_plan_created: false,
  approval_required_emitted: false,
  approval_received: null,
  pre_write_gate_result: null,
  draft_output_created: false,
  blocking_reason: null,
};

/** SSE 이벤트 하나를 받아 inspector 상태를 갱신 */
export function applyEventToInspector(
  prev: InspectorState,
  event: SSEEvent
): InspectorState {
  switch (event.type) {
    case "approval_required":
      return { ...prev, strategy_plan_created: true, approval_required_emitted: true };
    case "rejected":
      return { ...prev, approval_received: false };
    case "result":
      return { ...prev, draft_output_created: true };
    case "gate_blocked": {
      const d = event.data as { reason?: string; blockedBy?: string } | null;
      return {
        ...prev,
        pre_write_gate_result: "blocked",
        blocking_reason: d?.reason ?? d?.blockedBy ?? "gate 차단",
      };
    }
    case "error": {
      const d = event.data as { message?: string } | null;
      return {
        ...prev,
        blocking_reason: prev.blocking_reason ?? (d?.message ?? "알 수 없는 오류"),
      };
    }
    case "progress": {
      const msg = ((event.data as { message?: string } | null)?.message ?? "").toLowerCase();
      if (msg.includes("pre-write gate 통과")) {
        return { ...prev, pre_write_gate_result: "pass" };
      }
      if (msg.includes("pre-write gate 차단") || msg.includes("gate_blocked")) {
        return { ...prev, pre_write_gate_result: "blocked" };
      }
      return prev;
    }
    default:
      return prev;
  }
}

// ── 아이콘 헬퍼 ──────────────────────────────────────────────
function StatusDot({ ok }: { ok: boolean | null }) {
  if (ok === null) return <span className="inline-block w-2 h-2 rounded-full bg-zinc-300" />;
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${ok ? "bg-emerald-400" : "bg-red-400"}`} />
  );
}

// ── 컴포넌트 ─────────────────────────────────────────────────
interface PipelineStateInspectorProps {
  state: InspectorState;
}

export function PipelineStateInspector({ state }: PipelineStateInspectorProps) {
  // 승인 대기 중 강조 배너
  const awaitingApproval = state.approval_required_emitted && state.approval_received === null && !state.draft_output_created;

  const rows: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: "선택 주제",
      value: state.selected_topic
        ? <span className="text-zinc-800 truncate max-w-[220px] inline-block">{state.selected_topic}</span>
        : <span className="text-zinc-400">—</span>,
    },
    {
      label: "남은 주제 수",
      value: state.remaining_topics_count !== null
        ? <span className="font-mono text-zinc-700">{state.remaining_topics_count}개</span>
        : <span className="text-zinc-400">—</span>,
    },
    {
      label: "전략 수립",
      value: (
        <span className="flex items-center gap-1.5">
          <StatusDot ok={state.strategy_plan_created ? true : null} />
          {state.strategy_plan_created ? "완료" : "대기"}
        </span>
      ),
    },
    {
      label: "승인 요청",
      value: (
        <span className="flex items-center gap-1.5">
          <StatusDot ok={state.approval_required_emitted ? true : null} />
          {state.approval_required_emitted ? "발행됨" : "대기"}
        </span>
      ),
    },
    {
      label: "승인 응답",
      value: (
        <span className="flex items-center gap-1.5">
          <StatusDot ok={state.approval_received} />
          {state.approval_received === null
            ? "미응답"
            : state.approval_received ? "승인" : "거절"}
        </span>
      ),
    },
    {
      label: "pre-write gate",
      value: (
        <span className="flex items-center gap-1.5">
          <StatusDot
            ok={state.pre_write_gate_result === "pass" ? true : state.pre_write_gate_result === "blocked" ? false : null}
          />
          {state.pre_write_gate_result === "pass" ? "통과" : state.pre_write_gate_result === "blocked" ? "차단" : "대기"}
        </span>
      ),
    },
    {
      label: "본문 작성",
      value: (
        <span className="flex items-center gap-1.5">
          <StatusDot ok={state.draft_output_created ? true : null} />
          {state.draft_output_created ? "완료" : "대기"}
        </span>
      ),
    },
  ];

  return (
    <div className="bg-zinc-50 border border-zinc-200 rounded-xl overflow-hidden">
      {/* 승인 대기 강조 배너 */}
      {awaitingApproval && (
        <div className="bg-amber-50 border-b border-amber-200 px-4 py-2.5 flex items-center gap-2">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          <p className="text-xs font-semibold text-amber-700">승인 대기 중 — 위 다이얼로그에서 전략을 확인해주세요</p>
        </div>
      )}

      <div className="p-4">
        <p className="text-xs font-semibold text-zinc-500 mb-3 uppercase tracking-wide">파이프라인 상태</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {rows.map(({ label, value }) => (
            <div key={label} className="contents">
              <span className="text-xs text-zinc-400">{label}</span>
              <span className="text-xs">{value}</span>
            </div>
          ))}
        </div>

        {/* 차단/에러 사유 — 눈에 잘 보이게 별도 표시 */}
        {state.blocking_reason && (
          <div className="mt-3 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            <p className="text-xs font-semibold text-red-600 mb-1">차단 / 오류 사유</p>
            <p className="text-xs text-red-700 break-all">{state.blocking_reason}</p>
          </div>
        )}
      </div>
    </div>
  );
}
