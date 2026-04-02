/**
 * 파이프라인 실행 상태를 GitHub에 영속 저장하는 레저 모듈.
 * 서버 재시작 후에도 실행 중인 파이프라인 상태를 복원할 수 있다.
 */

import { writeJsonFile, readJsonFile, fileExists } from "@/lib/github/repository";
import type { PipelineState } from "./types";

const LEDGER_PATH = "data/pipeline-ledger/runs.json";

interface LedgerEntry {
  pipelineId: string;
  topicId: string;
  userId: string;
  stage: PipelineState["stage"];
  error: string | null;
  approvalGranted: boolean;
  postingListUpdated: boolean;
  indexUpdated: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Ledger {
  runs: LedgerEntry[];
  lastUpdated: string;
}

// ============================================================
// 레저 읽기/쓰기
// ============================================================

async function loadLedger(): Promise<{ data: Ledger; sha: string | null }> {
  if (!(await fileExists(LEDGER_PATH))) {
    return {
      data: { runs: [], lastUpdated: new Date().toISOString() },
      sha: null,
    };
  }
  return readJsonFile<Ledger>(LEDGER_PATH);
}

export async function upsertLedgerEntry(
  entry: Omit<LedgerEntry, "updatedAt">
): Promise<void> {
  const { data: ledger, sha } = await loadLedger();
  const now = new Date().toISOString();

  const existing = ledger.runs.findIndex((r) => r.pipelineId === entry.pipelineId);
  const updated: LedgerEntry = { ...entry, updatedAt: now };

  const newRuns =
    existing >= 0
      ? ledger.runs.map((r, i) => (i === existing ? updated : r))
      : [...ledger.runs, updated];

  await writeJsonFile<Ledger>(
    LEDGER_PATH,
    { runs: newRuns, lastUpdated: now },
    `chore: ledger upsert ${entry.pipelineId} → ${entry.stage}`,
    sha
  );
}

export async function getLedgerEntry(pipelineId: string): Promise<LedgerEntry | null> {
  const { data } = await loadLedger();
  return data.runs.find((r) => r.pipelineId === pipelineId) ?? null;
}

export async function getActiveLedgerEntries(): Promise<LedgerEntry[]> {
  const { data } = await loadLedger();
  return data.runs.filter(
    (r) => r.stage !== "complete" && r.stage !== "failed"
  );
}

// ============================================================
// 아티팩트 계약 저장 (writing 단계 완료 후)
// ============================================================

interface ArtifactContract {
  pipelineId: string;
  postId: string;
  topicId: string;
  userId: string;
  title: string;
  wordCount: number;
  contentPath: string;
  generatedAt: string;
  evalRunId: string | null;
  evalScore: number | null;
}

export async function saveArtifactContract(
  contract: ArtifactContract
): Promise<void> {
  const contractPath = `data/pipeline-ledger/artifacts/${contract.pipelineId}.json`;
  const exists = await fileExists(contractPath);
  if (exists) return; // 멱등성 보장

  await writeJsonFile(
    contractPath,
    contract,
    `feat: artifact contract ${contract.pipelineId}`,
    null
  );
}
