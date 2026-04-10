/**
 * 파이프라인 승인 체크포인트 — GitHub 기반 영속 저장소
 *
 * 서버 재시작 또는 Railway 다중 인스턴스 환경에서
 * 승인 상태가 메모리에서 소실되는 문제를 해결한다.
 *
 * 흐름:
 *   1. 파이프라인이 승인 단계 도달 → createApprovalRecord() 로 GitHub에 "waiting" 저장
 *   2. 사용자 승인 클릭 → resolveApprovalRecord() 로 "approved"/"rejected" 갱신
 *   3. 파이프라인 폴링 → readApprovalRecord() 로 상태 확인, 결정 후 deleteApprovalRecord() 정리
 */

import { readJsonFile, writeJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";

export interface ApprovalRecord {
  pipelineId: string;
  status: "waiting" | "approved" | "rejected" | "consumed";
  createdAt: string;
  resolvedAt?: string;
  approved?: boolean;
  modifications?: string | null;
}

/** 승인 대기 레코드 생성 */
export async function createApprovalRecord(pipelineId: string): Promise<void> {
  const record: ApprovalRecord = {
    pipelineId,
    status: "waiting",
    createdAt: new Date().toISOString(),
  };
  await writeJsonFile(
    Paths.approvalRecord(pipelineId),
    record,
    `chore: approval waiting ${pipelineId} [skip ci]`,
    null
  );
}

/** 승인/거절 결정 기록 — approve 엔드포인트에서 호출 */
export async function resolveApprovalRecord(
  pipelineId: string,
  approved: boolean,
  modifications?: string | null
): Promise<boolean> {
  const path = Paths.approvalRecord(pipelineId);
  if (!(await fileExists(path))) return false;

  const { sha, data: current } = await readJsonFile<ApprovalRecord>(path);
  if (current.status !== "waiting") return false;

  const updated: ApprovalRecord = {
    ...current,
    status: approved ? "approved" : "rejected",
    resolvedAt: new Date().toISOString(),
    approved,
    modifications: modifications ?? null,
  };
  await writeJsonFile(
    path,
    updated,
    `chore: approval ${approved ? "approved" : "rejected"} ${pipelineId} [skip ci]`,
    sha
  );
  return true;
}

/** 승인 레코드 읽기 */
export async function readApprovalRecord(pipelineId: string): Promise<ApprovalRecord | null> {
  const path = Paths.approvalRecord(pipelineId);
  if (!(await fileExists(path))) return null;
  const { data } = await readJsonFile<ApprovalRecord>(path);
  return data;
}

/** 완료 처리 — status를 consumed로 마킹 (best-effort, 실패해도 무관) */
export async function markApprovalConsumed(pipelineId: string): Promise<void> {
  try {
    const path = Paths.approvalRecord(pipelineId);
    if (!(await fileExists(path))) return;
    const { sha, data: current } = await readJsonFile<ApprovalRecord>(path);
    await writeJsonFile(
      path,
      { ...current, status: "consumed" as ApprovalRecord["status"] },
      `chore: approval consumed ${pipelineId} [skip ci]`,
      sha
    );
  } catch {
    // ignore
  }
}
