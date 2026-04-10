/**
 * 파이프라인 실행 상태를 GitHub에 영속 저장하는 레저 모듈.
 * 서버 재시작 후에도 실행 중인 파이프라인 상태를 복원할 수 있다.
 *
 * [동시성 설계]
 * 파이프라인별로 개별 파일 사용: data/pipeline-ledger/runs/{pipelineId}.json
 * 공유 파일을 쓰지 않으므로 다중 파이프라인 동시 실행 시 SHA 충돌이 발생하지 않는다.
 */

import { writeJsonFile, readJsonFile, fileExists, listFiles } from "@/lib/github/repository";
import type { PipelineState } from "./types";

function runPath(pipelineId: string): string {
  return `data/pipeline-ledger/runs/${pipelineId}.json`;
}

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

// ============================================================
// 레저 읽기/쓰기 (파이프라인별 개별 파일)
// ============================================================

export async function upsertLedgerEntry(
  entry: Omit<LedgerEntry, "updatedAt">
): Promise<void> {
  const path = runPath(entry.pipelineId);
  const now = new Date().toISOString();
  const updated: LedgerEntry = { ...entry, updatedAt: now };

  const MAX_RETRIES = 5;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let sha: string | null = null;
    try {
      const current = await readJsonFile<LedgerEntry>(path);
      sha = current.sha;
    } catch {
      // 파일 없음 — sha = null으로 신규 생성
    }

    try {
      await writeJsonFile<LedgerEntry>(
        path,
        updated,
        `chore: ledger upsert ${entry.pipelineId} → ${entry.stage} [skip ci]`,
        sha
      );
      return;
    } catch (err) {
      const status = (err as { status?: number }).status;
      const isConflict = status === 409 || status === 422;
      if (isConflict && attempt < MAX_RETRIES) {
        // jitter 딜레이: 50~200ms * attempt
        const jitter = Math.floor(Math.random() * 150) + 50;
        await new Promise((r) => setTimeout(r, jitter * attempt));
        continue;
      }
      throw err;
    }
  }
}

export async function getLedgerEntry(pipelineId: string): Promise<LedgerEntry | null> {
  const path = runPath(pipelineId);
  if (!(await fileExists(path))) return null;
  const { data } = await readJsonFile<LedgerEntry>(path);
  return data;
}

export async function getActiveLedgerEntries(): Promise<LedgerEntry[]> {
  const dir = "data/pipeline-ledger/runs";
  let files: Awaited<ReturnType<typeof listFiles>>;
  try {
    files = await listFiles(dir);
  } catch {
    return [];
  }

  const entries = await Promise.allSettled(
    files
      .filter((f) => f.name.endsWith(".json"))
      .map(async (f) => {
        const { data } = await readJsonFile<LedgerEntry>(`${dir}/${f.name}`);
        return data;
      })
  );

  return entries
    .filter((r): r is PromiseFulfilledResult<LedgerEntry> => r.status === "fulfilled")
    .map((r) => r.value)
    .filter((e) => e.stage !== "complete" && e.stage !== "failed");
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
