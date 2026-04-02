"use client";

import { useEffect, useState } from "react";
import type { ArtifactType } from "@/lib/agents/artifact-registry";

interface ArtifactMeta {
  type: ArtifactType;
  label: string;
  description: string;
}

const ARTIFACT_DEFS: ArtifactMeta[] = [
  { type: "source_report", label: "소스 리포트", description: "참조 URL 접근성 및 grounding 상태" },
  { type: "feasibility_report", label: "실행 가능성", description: "토픽 feasibility 판정 결과" },
  { type: "strategy_plan", label: "전략 계획", description: "strategy-planner 출력 아웃라인" },
  { type: "draft_output", label: "초안 메타", description: "master-writer 생성 메타 정보" },
  { type: "audit_report", label: "감사 리포트", description: "harness-evaluator 평가 결과" },
  { type: "approval_request", label: "승인 요청", description: "사용자 승인 요청 및 응답" },
  { type: "record_update", label: "기록 업데이트", description: "posting-list/index 업데이트 내역" },
];

interface ArtifactPanelProps {
  pipelineId: string;
}

export function ArtifactPanel({ pipelineId }: ArtifactPanelProps) {
  const [artifacts, setArtifacts] = useState<Partial<Record<ArtifactType, unknown>>>({});
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<ArtifactType | null>(null);

  useEffect(() => {
    if (!pipelineId) return;
    setLoading(true);
    fetch(`/api/pipeline/artifacts?pipelineId=${encodeURIComponent(pipelineId)}`)
      .then((r) => r.json())
      .then((d: { artifacts: Record<ArtifactType, { data: unknown }> }) => {
        const flat: Partial<Record<ArtifactType, unknown>> = {};
        for (const [k, v] of Object.entries(d.artifacts ?? {})) {
          flat[k as ArtifactType] = (v as { data: unknown }).data;
        }
        setArtifacts(flat);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [pipelineId]);

  const present = new Set(Object.keys(artifacts) as ArtifactType[]);

  return (
    <div className="bg-white border border-zinc-200 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-zinc-800 text-sm">아티팩트 추적</h3>
        <span className="text-xs text-zinc-400 font-mono">{pipelineId}</span>
      </div>

      {loading ? (
        <p className="text-xs text-zinc-400">로딩 중...</p>
      ) : (
        <div className="space-y-2">
          {ARTIFACT_DEFS.map((def) => {
            const exists = present.has(def.type);
            const data = artifacts[def.type];
            const isExpanded = expanded === def.type;

            return (
              <div key={def.type} className={`rounded-lg border ${exists ? "border-emerald-200 bg-emerald-50" : "border-zinc-100 bg-zinc-50"}`}>
                <button
                  className="w-full flex items-center gap-3 px-3 py-2 text-left"
                  onClick={() => exists && setExpanded(isExpanded ? null : def.type)}
                  disabled={!exists}
                >
                  <span className={`w-2 h-2 rounded-full flex-shrink-0 ${exists ? "bg-emerald-500" : "bg-zinc-300"}`} />
                  <span className="flex-1 min-w-0">
                    <span className="text-xs font-medium text-zinc-700 block">{def.label}</span>
                    <span className="text-xs text-zinc-400 truncate block">{def.description}</span>
                  </span>
                  {exists && (
                    <span className="text-xs text-emerald-600 font-mono flex-shrink-0">
                      {isExpanded ? "▲" : "▼"}
                    </span>
                  )}
                  {!exists && (
                    <span className="text-xs text-zinc-400 flex-shrink-0">미생성</span>
                  )}
                </button>

                {isExpanded && data !== undefined && (
                  <div className="px-3 pb-3">
                    <pre className="text-xs text-zinc-600 bg-white border border-zinc-100 rounded p-2 overflow-auto max-h-48 whitespace-pre-wrap">
                      {JSON.stringify(data, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-3 pt-3 border-t border-zinc-100 flex items-center justify-between">
        <span className="text-xs text-zinc-400">
          {present.size} / {ARTIFACT_DEFS.length}개 수집됨
        </span>
        <div className="flex gap-1">
          {ARTIFACT_DEFS.map((def) => (
            <span
              key={def.type}
              className={`w-1.5 h-1.5 rounded-full ${present.has(def.type) ? "bg-emerald-500" : "bg-zinc-200"}`}
              title={def.label}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
