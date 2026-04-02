/**
 * baseline-manager — 시나리오별 latest baseline 저장/비교
 *
 * 설계 원칙:
 *   - 자동 갱신 OFF: 파이프라인 실행 결과는 "candidate"로만 등록
 *   - 수동 승격(promoteToBaseline)만이 latest.json을 갱신
 *   - 승인된 run만 candidate 등록 가능 (approvedRunOnly 플래그)
 *
 * 저장 경로:
 *   evals/baselines/{scenarioId}/latest.json     — 승격된 최신 baseline
 *   evals/baselines/{scenarioId}/candidates.json — 수동 승격 대기 목록
 *
 * diff는 두 그룹으로 분리:
 *   deterministic — 재현 가능한 지표 (forbidden_check, structure)
 *   quality       — 주관적 지표 (originality, style_match, engagement)
 */

import { writeJsonFile, readJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";

// ============================================================
// 타입
// ============================================================

export interface BaselineRecord {
  runId: string;
  scenarioId: string;
  postId: string;
  savedAt: string;
  promotedAt: string;
  promotedBy: string;       // "system" | userId
  scores: Record<string, number>;
  aggregateScore: number;
  notes: string;
}

export interface BaselineCandidate {
  runId: string;
  scenarioId: string;
  postId: string;
  pipelineId: string;
  recordedAt: string;
  scores: Record<string, number>;
  aggregateScore: number;
  notes: string;
  evalPassed: boolean;      // aggregateScore >= PASS_THRESHOLD
}

export interface BaselineDiff {
  scenarioId: string;
  currentRunId: string;
  baselineRunId: string;
  deterministic: {
    dimension: string;
    baseline: number;
    current: number;
    delta: number;
    regression: boolean;
  }[];
  quality: {
    dimension: string;
    baseline: number;
    current: number;
    delta: number;
  }[];
  aggregateDelta: number;
  overallRegression: boolean;
  summary: string;
}

const DETERMINISTIC_DIMS = ["forbidden_check", "structure"];
const QUALITY_DIMS = ["originality", "style_match", "engagement"];
const REGRESSION_THRESHOLD = -5;
const PASS_THRESHOLD = 70;

// ============================================================
// 저장 (직접 호출 — promoteToBaseline에서만 사용)
// ============================================================

export async function saveBaseline(
  scenarioId: string,
  record: Omit<BaselineRecord, "savedAt">
): Promise<void> {
  const path = Paths.baseline(scenarioId);
  const exists = await fileExists(path);
  let sha: string | null = null;
  if (exists) {
    const current = await readJsonFile<BaselineRecord>(path);
    sha = current.sha;
  }
  await writeJsonFile<BaselineRecord>(
    path,
    { ...record, savedAt: new Date().toISOString() },
    `chore: promote baseline for scenario ${scenarioId} (run: ${record.runId})`,
    sha
  );
}

// ============================================================
// 조회
// ============================================================

export async function getBaseline(
  scenarioId: string
): Promise<BaselineRecord | null> {
  const path = Paths.baseline(scenarioId);
  if (!(await fileExists(path))) return null;
  const { data } = await readJsonFile<BaselineRecord>(path);
  return data;
}

// ============================================================
// Candidate 등록 (파이프라인 완료 후 → 자동 승격 X)
// ============================================================

export async function registerBaselineCandidate(params: {
  scenarioId: string;
  runId: string;
  postId: string;
  pipelineId: string;
  scores: Record<string, number>;
  aggregateScore: number;
  notes?: string;
}): Promise<{ registered: boolean; reason: string }> {
  if (params.aggregateScore < PASS_THRESHOLD) {
    return {
      registered: false,
      reason: `점수 미달 (${params.aggregateScore}점 < ${PASS_THRESHOLD}점) — candidate 등록 건너뜀`,
    };
  }

  const path = Paths.baselineCandidates(params.scenarioId);
  const now = new Date().toISOString();

  let list: BaselineCandidate[] = [];
  let sha: string | null = null;

  if (await fileExists(path)) {
    const result = await readJsonFile<BaselineCandidate[]>(path);
    list = result.data;
    sha = result.sha;
  }

  const candidate: BaselineCandidate = {
    runId: params.runId,
    scenarioId: params.scenarioId,
    postId: params.postId,
    pipelineId: params.pipelineId,
    recordedAt: now,
    scores: params.scores,
    aggregateScore: params.aggregateScore,
    notes: params.notes ?? "",
    evalPassed: params.aggregateScore >= PASS_THRESHOLD,
  };

  // 동일 runId 중복 방지
  const deduped = list.filter((c) => c.runId !== params.runId);
  await writeJsonFile(
    path,
    [...deduped, candidate],
    `chore: register baseline candidate ${params.runId} for ${params.scenarioId}`,
    sha
  );

  return {
    registered: true,
    reason: `candidate 등록 완료 (${params.aggregateScore}점)`,
  };
}

// ============================================================
// Candidate 목록 조회
// ============================================================

export async function listBaselineCandidates(
  scenarioId: string
): Promise<BaselineCandidate[]> {
  const path = Paths.baselineCandidates(scenarioId);
  if (!(await fileExists(path))) return [];
  const { data } = await readJsonFile<BaselineCandidate[]>(path);
  return data;
}

// ============================================================
// 수동 Baseline 승격
// ============================================================

export async function promoteToBaseline(params: {
  scenarioId: string;
  runId: string;
  promotedBy: string;
}): Promise<{ success: boolean; record: BaselineRecord | null; reason: string }> {
  const candidates = await listBaselineCandidates(params.scenarioId);
  const target = candidates.find((c) => c.runId === params.runId);

  if (!target) {
    return {
      success: false,
      record: null,
      reason: `candidate를 찾을 수 없습니다: ${params.runId}`,
    };
  }

  if (!target.evalPassed) {
    return {
      success: false,
      record: null,
      reason: `eval 미통과 run은 baseline으로 승격할 수 없습니다 (${target.aggregateScore}점)`,
    };
  }

  const record: Omit<BaselineRecord, "savedAt"> = {
    runId: target.runId,
    scenarioId: params.scenarioId,
    postId: target.postId,
    promotedAt: new Date().toISOString(),
    promotedBy: params.promotedBy,
    scores: target.scores,
    aggregateScore: target.aggregateScore,
    notes: target.notes,
  };

  await saveBaseline(params.scenarioId, record);

  // 승격된 candidate 목록에서 제거
  const path = Paths.baselineCandidates(params.scenarioId);
  const { data: list, sha } = await readJsonFile<BaselineCandidate[]>(path);
  await writeJsonFile(
    path,
    list.filter((c) => c.runId !== params.runId),
    `chore: remove promoted candidate ${params.runId}`,
    sha
  );

  const saved = await getBaseline(params.scenarioId);
  return {
    success: true,
    record: saved,
    reason: `baseline 승격 완료: ${target.aggregateScore}점 (by ${params.promotedBy})`,
  };
}

// ============================================================
// 비교 (순수 함수)
// ============================================================

export function compareWithBaseline(params: {
  scenarioId: string;
  current: { runId: string; scores: Record<string, number>; aggregateScore: number };
  baseline: BaselineRecord;
}): BaselineDiff {
  const { scenarioId, current, baseline } = params;

  const deterministic = DETERMINISTIC_DIMS.map((dim) => {
    const b = baseline.scores[dim] ?? 0;
    const c = current.scores[dim] ?? 0;
    const delta = c - b;
    return { dimension: dim, baseline: b, current: c, delta, regression: delta <= REGRESSION_THRESHOLD };
  });

  const quality = QUALITY_DIMS.map((dim) => {
    const b = baseline.scores[dim] ?? 0;
    const c = current.scores[dim] ?? 0;
    return { dimension: dim, baseline: b, current: c, delta: c - b };
  });

  const aggregateDelta = current.aggregateScore - baseline.aggregateScore;
  const overallRegression =
    deterministic.some((d) => d.regression) || aggregateDelta <= REGRESSION_THRESHOLD;

  const regressionDims = deterministic.filter((d) => d.regression).map((d) => d.dimension);

  const summary = overallRegression
    ? `⚠ 회귀 감지: ${regressionDims.length > 0 ? regressionDims.join(", ") : "종합 점수"} 하락 (delta: ${aggregateDelta > 0 ? "+" : ""}${aggregateDelta}점)`
    : `✓ 회귀 없음: 종합 점수 delta ${aggregateDelta > 0 ? "+" : ""}${aggregateDelta}점`;

  return {
    scenarioId,
    currentRunId: current.runId,
    baselineRunId: baseline.runId,
    deterministic,
    quality,
    aggregateDelta,
    overallRegression,
    summary,
  };
}

// ============================================================
// 편의 함수 — baseline과 현재 결과 비교 (baseline 없으면 null)
// ============================================================

export async function compareWithCurrentBaseline(params: {
  scenarioId: string;
  current: { runId: string; scores: Record<string, number>; aggregateScore: number };
}): Promise<BaselineDiff | null> {
  const baseline = await getBaseline(params.scenarioId);
  if (!baseline) return null;
  return compareWithBaseline({ ...params, baseline });
}
