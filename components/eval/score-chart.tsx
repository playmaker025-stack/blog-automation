import type { EvalResult } from "@/lib/agents/types";

const LABELS: Record<keyof EvalResult["scores"], string> = {
  originality:    "독창성",
  style_match:    "스타일 일치",
  structure:      "구조",
  engagement:     "몰입도",
  forbidden_check: "금지 표현",
};

interface Props {
  scores: EvalResult["scores"];
  aggregateScore: number;
}

export function ScoreChart({ scores, aggregateScore }: Props) {
  const scoreColor = (s: number) =>
    s >= 80 ? "bg-emerald-500" : s >= 70 ? "bg-amber-400" : "bg-red-400";

  const aggregateColor =
    aggregateScore >= 80
      ? "text-emerald-600"
      : aggregateScore >= 70
      ? "text-amber-600"
      : "text-red-600";

  return (
    <div className="bg-white border border-zinc-200 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-zinc-700">Eval 점수</h3>
        <div className="text-right">
          <span className={`text-2xl font-bold ${aggregateColor}`}>{aggregateScore}</span>
          <span className="text-sm text-zinc-400">/100</span>
        </div>
      </div>

      <div className="space-y-3">
        {(Object.entries(scores) as [keyof EvalResult["scores"], number][]).map(
          ([dim, score]) => (
            <div key={dim}>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-zinc-600">{LABELS[dim]}</span>
                <span className="font-medium text-zinc-800">{score}</span>
              </div>
              <div className="h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${scoreColor(score)}`}
                  style={{ width: `${score}%` }}
                />
              </div>
            </div>
          )
        )}
      </div>

      <div className="mt-4 pt-3 border-t border-zinc-100">
        <div className="flex justify-between text-xs">
          <span className="text-zinc-500">합격 기준</span>
          <span className={aggregateScore >= 70 ? "text-emerald-600 font-medium" : "text-red-500 font-medium"}>
            {aggregateScore >= 70 ? "통과" : "미달"} (기준: 70점)
          </span>
        </div>
      </div>
    </div>
  );
}
