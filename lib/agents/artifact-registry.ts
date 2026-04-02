/**
 * artifact-registry — run별 10종 아티팩트 저장 및 조회
 *
 * 저장 경로: data/pipeline-ledger/artifacts/{pipelineId}/{type}.json
 *
 * 성공 아티팩트 (7종):
 *   source_report      — sourceResolver 결과
 *   feasibility_report — topic-feasibility 결과
 *   strategy_plan      — strategy-planner 출력
 *   draft_output       — master-writer 메타 (본문 내용은 별도 경로)
 *   audit_report       — harness-evaluator 결과
 *   approval_request   — 승인 요청 내용 + 응답
 *   record_update      — posting-list / index 업데이트 내역
 *
 * 실패 추적 아티팩트 (3종) — gate fail 시에도 반드시 저장:
 *   gate_failure_report — 차단 조건 + 상세 이유
 *   run_state_snapshot  — 차단 시점 파이프라인 전체 상태
 *   blocking_reason     — 간결한 차단 사유 (UI 표시용)
 */

import { writeJsonFile, readJsonFile, fileExists } from "@/lib/github/repository";

// ============================================================
// 아티팩트 타입
// ============================================================

export type ArtifactType =
  | "source_report"
  | "feasibility_report"
  | "strategy_plan"
  | "draft_output"
  | "audit_report"
  | "approval_request"
  | "record_update"
  // 실패 추적 (gate fail 시 저장)
  | "gate_failure_report"
  | "run_state_snapshot"
  | "blocking_reason";

export interface ArtifactEnvelope<T = unknown> {
  pipelineId: string;
  type: ArtifactType;
  savedAt: string;
  data: T;
}

// 개별 타입 정의
export interface SourceReportData {
  resolvedSources: Array<{
    url: string;
    title: string;
    excerpt: string;
    accessible: boolean;
    error?: string;
  }>;
  groundingStatus: "sufficient" | "partial" | "insufficient_grounding";
  accessibleCount: number;
  totalCount: number;
}

export interface FeasibilityReportData {
  topicId: string;
  score: number;
  verdict: "feasible" | "uncertain" | "blocked";
  reasons: string[];
}

export interface StrategyPlanData {
  title: string;
  outline: unknown[];
  keyPoints: string[];
  estimatedLength: number;
  tone: string;
  keywords: string[];
  rationale: string;
  corpusSummary: unknown; // CorpusSummaryArtifact
}

export interface DraftOutputData {
  postId: string;
  title: string;
  wordCount: number;
  generatedAt: string;
  contentPath: string;
  corpusSummaryUsed: boolean;
}

export interface AuditReportData {
  runId: string;
  scores: Record<string, number>;
  aggregateScore: number;
  reasoning: Record<string, string>;
  recommendations: string[];
  pass: boolean;
  baselineDelta: number | null;
}

export interface ApprovalRequestData {
  pipelineId: string;
  previousTitle: string;
  proposedTitle: string;
  materialChange: boolean;
  materialChangeSignals: string[];
  rationale: string;
  requestedAt: string;
  response: {
    approved: boolean;
    respondedAt: string | null;
    modifications: string | null;
  };
}

export interface RecordUpdateData {
  postingListUpdated: boolean;
  postingListUpdatedAt: string | null;
  indexUpdated: boolean;
  indexUpdatedAt: string | null;
  postId: string | null;
  topicStatusBefore: string;
  topicStatusAfter: string;
}

// ── 실패 추적 아티팩트 ──────────────────────────────────────

export interface GateFailureReportData {
  gate: "pre-write" | "post-audit";
  blockedBy: string;
  reason: string;
  evalScore?: number;
  evalScores?: Record<string, number>;
  recommendations?: string[];
  baselineDelta?: number | null;
  blockedAt: string;
}

export interface RunStateSnapshotData {
  pipelineId: string;
  topicId: string;
  userId: string;
  stage: string;
  approvalState: string;
  postId: string | null;
  strategyTitle: string | null;
  wordCount: number | null;
  evalScore: number | null;
  postingListUpdated: boolean;
  indexUpdated: boolean;
  snapshotAt: string;
}

export interface BlockingReasonData {
  gate: "pre-write" | "post-audit";
  code: string;          // blockedBy 값
  summary: string;       // 한 문장 요약 (UI 표시용)
  actionRequired: string; // 사용자 취해야 할 조치
  canRetry: boolean;     // 수정 후 재시도 가능 여부
}

// ============================================================
// 저장
// ============================================================

function artifactPath(pipelineId: string, type: ArtifactType): string {
  return `data/pipeline-ledger/artifacts/${pipelineId}/${type}.json`;
}

export async function saveArtifact<T>(
  pipelineId: string,
  type: ArtifactType,
  data: T
): Promise<void> {
  const envelope: ArtifactEnvelope<T> = {
    pipelineId,
    type,
    savedAt: new Date().toISOString(),
    data,
  };

  const path = artifactPath(pipelineId, type);
  const exists = await fileExists(path);
  let sha: string | null = null;
  if (exists) {
    const current = await readJsonFile<ArtifactEnvelope>(path);
    sha = current.sha;
  }

  await writeJsonFile(
    path,
    envelope,
    `chore: artifact ${type} for pipeline ${pipelineId}`,
    sha
  );
}

// ============================================================
// 조회
// ============================================================

export async function getArtifact<T = unknown>(
  pipelineId: string,
  type: ArtifactType
): Promise<ArtifactEnvelope<T> | null> {
  const path = artifactPath(pipelineId, type);
  if (!(await fileExists(path))) return null;
  const { data } = await readJsonFile<ArtifactEnvelope<T>>(path);
  return data;
}

export async function getAllArtifacts(
  pipelineId: string
): Promise<Partial<Record<ArtifactType, ArtifactEnvelope>>> {
  const types: ArtifactType[] = [
    "source_report",
    "feasibility_report",
    "strategy_plan",
    "draft_output",
    "audit_report",
    "approval_request",
    "record_update",
  ];

  const results = await Promise.allSettled(
    types.map((t) => getArtifact(pipelineId, t))
  );

  const out: Partial<Record<ArtifactType, ArtifactEnvelope>> = {};
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) {
      out[types[i]] = r.value;
    }
  });
  return out;
}
