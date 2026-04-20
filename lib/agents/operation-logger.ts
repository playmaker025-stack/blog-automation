/**
 * operation-logger — 실운영 품질 점검용 로그 수집기
 *
 * 수집 항목:
 *   corpus_retrieval       — exemplar 선택 품질, stale 경고
 *   material_change        — 4-signal 판정 결과
 *   gate_result            — pre-write / post-audit gate 결과
 *   approval_ux            — 승인 요청 → 응답 소요 시간
 *   baseline_candidate     — candidate 등록/거부
 *
 * 저장 경로: data/pipeline-ledger/operation-log.json (최대 500건 rolling)
 */

import { writeJsonFile, readJsonFile, fileExists } from "@/lib/github/repository";

// 파이프라인별 독립 파일 사용 — 공유 파일 SHA 충돌 방지
// 조회용으로만 단일 파일도 유지 (쓰기는 하지 않음)
const LEGACY_LOG_PATH = "data/pipeline-ledger/operation-log.json";
const MAX_ENTRIES = 500;

function pipelineLogPath(pipelineId: string): string {
  return `data/pipeline-ledger/logs/${pipelineId}.json`;
}

// ============================================================
// 타입
// ============================================================

export type LogEntryType =
  | "corpus_retrieval"
  | "material_change"
  | "gate_result"
  | "approval_ux"
  | "baseline_candidate";

export interface CorpusRetrievalLog {
  type: "corpus_retrieval";
  userId: string;
  selectedCount: number;
  strategy: "exemplar_index" | "fallback_recent";
  staleCount: number;
  staleWarnings: string[];
  topScores: Array<{ sampleId: string; finalScore: number }>;
  targetIntent?: string;
  targetCategory?: string;
}

export interface MaterialChangeLog {
  type: "material_change";
  originalTitle: string;
  proposedTitle: string;
  isMaterial: boolean;
  triggeredSignals: string[];
  stringSimilarity: number;
  overrideByHighSim: boolean;
}

export interface GateResultLog {
  type: "gate_result";
  gate: "pre-write" | "post-audit";
  passed: boolean;
  blockedBy: string | null;
  reason: string;
  evalScore?: number;
}

export interface ApprovalUxLog {
  type: "approval_ux";
  materialChange: boolean;
  requestedAt: string;
  respondedAt: string | null;
  approved: boolean | null;
  elapsedMs: number | null;    // null = 미응답/타임아웃
  timedOut: boolean;
}

export interface BaselineCandidateLog {
  type: "baseline_candidate";
  scenarioId: string;
  runId: string;
  aggregateScore: number;
  registered: boolean;
  reason: string;
}

// pipelineId + at 는 appendLog에서 주입 — 개별 타입에서 제외
type LogPayload =
  | CorpusRetrievalLog
  | MaterialChangeLog
  | GateResultLog
  | ApprovalUxLog
  | BaselineCandidateLog;

export type LogEntry = LogPayload & { pipelineId: string; at: string };

interface LogFile {
  entries: LogEntry[];
  lastUpdated: string;
}

// ============================================================
// 읽기 / 쓰기
// ============================================================

async function loadPipelineLog(pipelineId: string): Promise<{ data: LogFile; sha: string | null }> {
  const path = pipelineLogPath(pipelineId);
  if (!(await fileExists(path))) {
    return { data: { entries: [], lastUpdated: new Date().toISOString() }, sha: null };
  }
  return readJsonFile<LogFile>(path);
}

export async function appendLog(
  pipelineId: string,
  entry: LogPayload
): Promise<void> {
  // 파이프라인별 독립 파일에 append — SHA 충돌 없음
  try {
    const { data: log, sha } = await loadPipelineLog(pipelineId);
    const now = new Date().toISOString();
    const newEntry: LogEntry = { ...entry, pipelineId, at: now } as LogEntry;
    const entries = [...log.entries, newEntry].slice(-MAX_ENTRIES);
    await writeJsonFile<LogFile>(
      pipelineLogPath(pipelineId),
      { entries, lastUpdated: now },
      `log: ${entry.type} pipeline=${pipelineId}`,
      sha
    );
  } catch {
    // 로그 실패는 파이프라인을 중단시키지 않음
  }
}

// ============================================================
// 조회 / 분석
// ============================================================

export async function getLogEntries(params?: {
  type?: LogEntryType;
  pipelineId?: string;
  limit?: number;
}): Promise<LogEntry[]> {
  if (params?.pipelineId) {
    const { data: log } = await loadPipelineLog(params.pipelineId);
    let entries = log.entries;
    if (params.type) entries = entries.filter((e) => e.type === params.type);
    if (params.limit) entries = entries.slice(-params.limit);
    return entries;
  }
  // pipelineId 없이 전체 조회 — 레거시 단일 파일 fallback
  try {
    if (!(await fileExists(LEGACY_LOG_PATH))) return [];
    const { data: log } = await readJsonFile<LogFile>(LEGACY_LOG_PATH);
    let entries = log.entries;
    if (params?.type) entries = entries.filter((e) => e.type === params.type);
    if (params?.limit) entries = entries.slice(-params.limit);
    return entries;
  } catch {
    return [];
  }
}

export async function getQualityReport(): Promise<{
  totalEntries: number;
  corpusRetrieval: {
    totalRuns: number;
    avgSelectedCount: number;
    staleWarningRate: number;
    fallbackRate: number;
  };
  materialChange: {
    totalJudgments: number;
    materialRate: number;
    overrideBySimRate: number;
    avgSignalsTriggered: number;
  };
  gateResults: {
    preWritePassRate: number;
    postAuditPassRate: number;
    topBlockReasons: Record<string, number>;
  };
  approvalUx: {
    totalRequests: number;
    approvalRate: number;
    avgElapsedMs: number | null;
    timeoutRate: number;
    materialChangeApprovalRate: number;
  };
  baselineCandidates: {
    registrationRate: number;
    totalAttempts: number;
  };
}> {
  // getQualityReport는 레거시 단일 파일만 읽음 (신규 파이프라인별 파일은 별도 집계 필요)
  if (!(await fileExists(LEGACY_LOG_PATH))) {
    return {
      totalEntries: 0,
      corpusRetrieval: { totalRuns: 0, avgSelectedCount: 0, staleWarningRate: 0, fallbackRate: 0 },
      materialChange: { totalJudgments: 0, materialRate: 0, overrideBySimRate: 0, avgSignalsTriggered: 0 },
      gateResults: { preWritePassRate: 1, postAuditPassRate: 1, topBlockReasons: {} },
      approvalUx: { totalRequests: 0, approvalRate: 0, avgElapsedMs: null, timeoutRate: 0, materialChangeApprovalRate: 0 },
      baselineCandidates: { registrationRate: 0, totalAttempts: 0 },
    };
  }
  const { data: log } = await readJsonFile<LogFile>(LEGACY_LOG_PATH);

  const corpus = log.entries.filter((e): e is CorpusRetrievalLog & { at: string; pipelineId: string } =>
    e.type === "corpus_retrieval"
  );
  const mc = log.entries.filter((e): e is MaterialChangeLog & { at: string; pipelineId: string } =>
    e.type === "material_change"
  );
  const gates = log.entries.filter((e): e is GateResultLog & { at: string; pipelineId: string } =>
    e.type === "gate_result"
  );
  const approval = log.entries.filter((e): e is ApprovalUxLog & { at: string; pipelineId: string } =>
    e.type === "approval_ux"
  );
  const candidates = log.entries.filter((e): e is BaselineCandidateLog & { at: string; pipelineId: string } =>
    e.type === "baseline_candidate"
  );

  const preWriteGates = gates.filter((g) => g.gate === "pre-write");
  const postAuditGates = gates.filter((g) => g.gate === "post-audit");

  const blockReasons: Record<string, number> = {};
  gates.filter((g) => !g.passed && g.blockedBy).forEach((g) => {
    blockReasons[g.blockedBy!] = (blockReasons[g.blockedBy!] ?? 0) + 1;
  });

  const respondedApprovals = approval.filter((a) => a.elapsedMs !== null);
  const avgElapsed =
    respondedApprovals.length > 0
      ? Math.round(respondedApprovals.reduce((sum, a) => sum + (a.elapsedMs ?? 0), 0) / respondedApprovals.length)
      : null;

  const mcApprovals = approval.filter((a) => a.materialChange && a.approved !== null);

  return {
    totalEntries: log.entries.length,
    corpusRetrieval: {
      totalRuns: corpus.length,
      avgSelectedCount: corpus.length > 0
        ? Math.round(corpus.reduce((s, c) => s + c.selectedCount, 0) / corpus.length * 10) / 10
        : 0,
      staleWarningRate: corpus.length > 0
        ? Math.round(corpus.filter((c) => c.staleCount > 0).length / corpus.length * 100) / 100
        : 0,
      fallbackRate: corpus.length > 0
        ? Math.round(corpus.filter((c) => c.strategy === "fallback_recent").length / corpus.length * 100) / 100
        : 0,
    },
    materialChange: {
      totalJudgments: mc.length,
      materialRate: mc.length > 0
        ? Math.round(mc.filter((m) => m.isMaterial).length / mc.length * 100) / 100
        : 0,
      overrideBySimRate: mc.length > 0
        ? Math.round(mc.filter((m) => m.overrideByHighSim).length / mc.length * 100) / 100
        : 0,
      avgSignalsTriggered: mc.length > 0
        ? Math.round(mc.reduce((s, m) => s + m.triggeredSignals.length, 0) / mc.length * 10) / 10
        : 0,
    },
    gateResults: {
      preWritePassRate: preWriteGates.length > 0
        ? Math.round(preWriteGates.filter((g) => g.passed).length / preWriteGates.length * 100) / 100
        : 1,
      postAuditPassRate: postAuditGates.length > 0
        ? Math.round(postAuditGates.filter((g) => g.passed).length / postAuditGates.length * 100) / 100
        : 1,
      topBlockReasons: blockReasons,
    },
    approvalUx: {
      totalRequests: approval.length,
      approvalRate: approval.length > 0
        ? Math.round(approval.filter((a) => a.approved).length / approval.length * 100) / 100
        : 0,
      avgElapsedMs: avgElapsed,
      timeoutRate: approval.length > 0
        ? Math.round(approval.filter((a) => a.timedOut).length / approval.length * 100) / 100
        : 0,
      materialChangeApprovalRate: mcApprovals.length > 0
        ? Math.round(mcApprovals.filter((a) => a.approved).length / mcApprovals.length * 100) / 100
        : 0,
    },
    baselineCandidates: {
      totalAttempts: candidates.length,
      registrationRate: candidates.length > 0
        ? Math.round(candidates.filter((c) => c.registered).length / candidates.length * 100) / 100
        : 0,
    },
  };
}
