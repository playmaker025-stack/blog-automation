import type { PipelineStage } from "@/lib/types/agent";

const STAGES: { key: PipelineStage; label: string }[] = [
  { key: "strategy-planning", label: "전략 수립" },
  { key: "awaiting-approval", label: "승인 대기" },
  { key: "writing", label: "본문 작성" },
  { key: "evaluating", label: "품질 평가" },
  { key: "complete", label: "완료" },
];

const STAGE_ORDER: PipelineStage[] = [
  "idle",
  "strategy-planning",
  "awaiting-approval",
  "writing",
  "evaluating",
  "gate_blocked",
  "complete",
  "failed",
];

function stageIndex(stage: PipelineStage): number {
  return STAGE_ORDER.indexOf(stage);
}

interface Props {
  currentStage: PipelineStage;
}

export function StageIndicator({ currentStage }: Props) {
  const currentIdx = stageIndex(currentStage);
  const isFailed = currentStage === "failed";
  const isGateBlocked = currentStage === "gate_blocked";

  return (
    <div className="flex items-center gap-0">
      {STAGES.map((s, i) => {
        const sIdx = stageIndex(s.key);
        const done = !isFailed && currentIdx > sIdx;
        const active = !isFailed && !isGateBlocked && currentIdx === sIdx;
        // gate_blocked 시 "품질 평가" 단계를 경고(앰버) 스타일로 표시
        const gateFailedHere = isGateBlocked && s.key === "evaluating";

        return (
          <div key={s.key} className="flex items-center">
            <div className="flex flex-col items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold border-2 transition-colors ${
                  isFailed && active
                    ? "border-red-500 bg-red-50 text-red-600"
                    : gateFailedHere
                    ? "border-amber-500 bg-amber-50 text-amber-600"
                    : done
                    ? "border-emerald-500 bg-emerald-500 text-white"
                    : active
                    ? "border-blue-500 bg-blue-50 text-blue-600"
                    : "border-zinc-300 bg-white text-zinc-400"
                }`}
              >
                {gateFailedHere ? "⚠" : done ? "✓" : i + 1}
              </div>
              <span
                className={`mt-1 text-xs whitespace-nowrap ${
                  gateFailedHere
                    ? "text-amber-600 font-medium"
                    : done
                    ? "text-emerald-600"
                    : active
                    ? "text-blue-600 font-medium"
                    : "text-zinc-400"
                }`}
              >
                {s.label}
              </span>
            </div>
            {i < STAGES.length - 1 && (
              <div
                className={`w-12 h-0.5 mb-4 transition-colors ${
                  done || gateFailedHere ? "bg-emerald-400" : "bg-zinc-200"
                }`}
              />
            )}
          </div>
        );
      })}

      {isFailed && (
        <div className="ml-4 text-sm text-red-500 font-medium">실패</div>
      )}
      {isGateBlocked && (
        <div className="ml-4 text-sm text-amber-600 font-medium">품질 미달</div>
      )}
    </div>
  );
}
