"use client";

import { useEffect, useState } from "react";
import { ScoreChart } from "@/components/eval/score-chart";
import { ArtifactPanel } from "@/components/eval/artifact-panel";
import { BaselinePromoter } from "@/components/eval/baseline-promoter";
import type { EvalResult } from "@/lib/agents/types";
import type { BaselineResult } from "@/lib/types/github-data";

interface RunItem extends BaselineResult {
  pass?: boolean;
  pipelineId?: string;
}

export default function EvalPage() {
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [selected, setSelected] = useState<RunItem | null>(null);
  const [activeTab, setActiveTab] = useState<"score" | "artifacts" | "baseline">("score");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/github/eval/baselines")
      .then((r) => r.json())
      .then((d: { results: BaselineResult[] }) => {
        const sorted = (d.results ?? []).sort(
          (a, b) => new Date(b.runAt).getTime() - new Date(a.runAt).getTime()
        );
        setRuns(sorted);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const avgScore =
    runs.length > 0
      ? Math.round(runs.reduce((a, r) => a + r.aggregateScore, 0) / runs.length)
      : null;

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-zinc-900">Eval 결과</h1>
        <p className="text-zinc-500 mt-1 text-sm">품질 평가 이력 · Baseline 관리</p>
      </div>

      {/* 요약 */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white border border-zinc-200 rounded-xl p-4 text-center">
          <p className="text-3xl font-bold text-zinc-900">{runs.length}</p>
          <p className="text-xs text-zinc-500 mt-1">총 평가 횟수</p>
        </div>
        <div className="bg-white border border-zinc-200 rounded-xl p-4 text-center">
          <p className={`text-3xl font-bold ${avgScore !== null && avgScore >= 70 ? "text-emerald-600" : "text-zinc-400"}`}>
            {avgScore !== null ? `${avgScore}점` : "-"}
          </p>
          <p className="text-xs text-zinc-500 mt-1">평균 점수</p>
        </div>
        <div className="bg-white border border-zinc-200 rounded-xl p-4 text-center">
          <p className="text-3xl font-bold text-emerald-600">
            {runs.filter((r) => r.aggregateScore >= 70).length}
          </p>
          <p className="text-xs text-zinc-500 mt-1">합격 (70점 이상)</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* 목록 */}
        <div>
          {loading ? (
            <p className="text-zinc-400 text-sm">로딩 중...</p>
          ) : runs.length === 0 ? (
            <p className="text-zinc-400 text-sm text-center py-12">평가 기록이 없습니다.</p>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => (
                <button
                  key={run.runId}
                  onClick={() => { setSelected(run); setActiveTab("score"); }}
                  className={`w-full text-left bg-white border rounded-xl p-4 hover:shadow-sm transition-all ${
                    selected?.runId === run.runId ? "border-blue-400 ring-1 ring-blue-400" : "border-zinc-200"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-mono text-zinc-500">{run.runId}</p>
                    <span className={`text-sm font-bold ${run.aggregateScore >= 80 ? "text-emerald-600" : run.aggregateScore >= 70 ? "text-amber-600" : "text-red-500"}`}>
                      {run.aggregateScore}점
                    </span>
                  </div>
                  <p className="text-xs text-zinc-400 mt-1">
                    {new Date(run.runAt).toLocaleString("ko-KR")}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <p className="text-xs text-zinc-500">케이스: {run.caseId || "-"}</p>
                    {run.pipelineId && (
                      <p className="text-xs font-mono text-zinc-400">{run.pipelineId}</p>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 상세 패널 */}
        <div>
          {selected ? (
            <div className="space-y-3">
              {/* 탭 */}
              <div className="flex gap-1 bg-zinc-100 rounded-lg p-1">
                {(["score", "artifacts", "baseline"] as const).map((tab) => (
                  <button
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    className={`flex-1 text-xs py-1.5 rounded-md font-medium transition-all ${
                      activeTab === tab
                        ? "bg-white text-zinc-900 shadow-sm"
                        : "text-zinc-500 hover:text-zinc-700"
                    }`}
                  >
                    {tab === "score" ? "점수" : tab === "artifacts" ? "아티팩트" : "Baseline"}
                  </button>
                ))}
              </div>

              {activeTab === "score" && (
                <ScoreChart
                  scores={selected.scores as EvalResult["scores"]}
                  aggregateScore={selected.aggregateScore}
                />
              )}
              {activeTab === "artifacts" && selected.pipelineId && (
                <ArtifactPanel pipelineId={selected.pipelineId} />
              )}
              {activeTab === "artifacts" && !selected.pipelineId && (
                <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-6 text-center">
                  <p className="text-xs text-zinc-400">pipelineId 정보가 없습니다.</p>
                </div>
              )}
              {activeTab === "baseline" && (
                <BaselinePromoter
                  scenarioId={selected.caseId || selected.runId}
                  onPromoted={() => {}}
                />
              )}
            </div>
          ) : (
            <div className="bg-zinc-50 border border-zinc-200 rounded-xl p-8 text-center">
              <p className="text-sm text-zinc-400">목록에서 평가 결과를 선택하세요.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
