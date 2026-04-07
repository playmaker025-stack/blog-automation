"use client";

import { useEffect, useState } from "react";
import type { BaselineCandidate, BaselineRecord } from "@/lib/agents/baseline-manager";

interface BaselinePromoterProps {
  scenarioId: string;  // topicId 기준
  onPromoted?: (record: BaselineRecord) => void;
}

export function BaselinePromoter({ scenarioId, onPromoted }: BaselinePromoterProps) {
  const [candidates, setCandidates] = useState<BaselineCandidate[]>([]);
  const [current, setCurrent] = useState<BaselineRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [promoting, setPromoting] = useState<string | null>(null);

  const loadData = () => {
    setLoading(true);
    Promise.all([
      fetch(`/api/pipeline/baseline?scenarioId=${encodeURIComponent(scenarioId)}`).then((r) => r.json()),
      fetch(`/api/pipeline/baseline?scenarioId=${encodeURIComponent(scenarioId)}&view=candidates`).then((r) => r.json()),
    ])
      .then(([baselineData, candidatesData]) => {
        setCurrent(baselineData.baseline ?? null);
        setCandidates(
          (candidatesData.candidates ?? []).sort(
            (a: BaselineCandidate, b: BaselineCandidate) => b.aggregateScore - a.aggregateScore
          )
        );
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadData(); }, [scenarioId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handlePromote = async (runId: string) => {
    setPromoting(runId);
    try {
      const res = await fetch("/api/pipeline/baseline", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "promote", scenarioId, runId, promotedBy: "user" }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error ?? "승격 실패");
        return;
      }
      onPromoted?.(data.record);
      loadData();
    } finally {
      setPromoting(null);
    }
  };

  if (loading) return <p className="text-xs text-zinc-400">로딩 중...</p>;

  return (
    <div className="bg-white border border-zinc-200 rounded-xl p-5 space-y-4">
      <h3 className="font-semibold text-zinc-800 text-sm">Baseline 관리</h3>

      {/* 현재 baseline */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
        <p className="text-xs font-medium text-blue-700 mb-1">현재 Baseline</p>
        {current ? (
          <div className="space-y-0.5">
            <p className="text-xs font-mono text-blue-800">{current.runId}</p>
            <p className="text-xs text-blue-600">{current.aggregateScore}점 · 승격자: {current.promotedBy}</p>
            <p className="text-xs text-blue-500">{new Date(current.promotedAt).toLocaleString("ko-KR")}</p>
          </div>
        ) : (
          <p className="text-xs text-blue-500">baseline이 없습니다. 아래에서 승격하세요.</p>
        )}
      </div>

      {/* candidates */}
      <div>
        <p className="text-xs font-medium text-zinc-600 mb-2">
          승격 대기 ({candidates.length}개)
          <span className="text-zinc-400 font-normal ml-1">— eval 통과 run만 표시</span>
        </p>

        {candidates.length === 0 ? (
          <p className="text-xs text-zinc-400 text-center py-4">승격 대기 중인 candidate가 없습니다.</p>
        ) : (
          <div className="space-y-2">
            {candidates.map((c) => (
              <div
                key={c.runId}
                className={`flex items-center gap-3 p-3 rounded-lg border ${
                  c.evalPassed ? "border-zinc-200 bg-zinc-50" : "border-zinc-100 bg-zinc-50 opacity-60"
                }`}
              >
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-mono text-zinc-700 truncate">{c.runId}</p>
                  <p className="text-xs text-zinc-500">
                    {c.aggregateScore}점 · {new Date(c.recordedAt).toLocaleString("ko-KR")}
                  </p>
                  {!c.evalPassed && (
                    <p className="text-xs text-red-500 mt-0.5">eval 미통과 — 승격 불가</p>
                  )}
                </div>
                {c.evalPassed && (
                  <button
                    onClick={() => handlePromote(c.runId)}
                    disabled={promoting === c.runId}
                    className="text-xs px-3 py-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex-shrink-0"
                  >
                    {promoting === c.runId ? "승격 중..." : "Baseline 승격"}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
