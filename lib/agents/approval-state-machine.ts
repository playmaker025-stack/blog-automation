/**
 * approval-state-machine — 파이프라인 승인 흐름 상태 관리
 *
 * States:
 *   draft_ready                  — 전략 완료, 승인 요청 전
 *   waiting_for_user_approval    — 승인 요청 발송, 사용자 응답 대기
 *   approved_pending_record_update — 사용자 승인, posting-list/index 미반영
 *   records_updated              — posting-list + index 반영 완료
 *   audit_failed                 — post-audit gate 차단 (draft 보존, 배포 불가)
 *   released                     — 모든 gate 통과, 최종 배포 완료
 *
 * 허용 전이:
 *   draft_ready                  → waiting_for_user_approval
 *   waiting_for_user_approval    → approved_pending_record_update (승인)
 *   waiting_for_user_approval    → draft_ready (거절 — 재시도 가능)
 *   approved_pending_record_update → records_updated
 *   records_updated              → audit_failed (gate 차단)
 *   records_updated              → released (gate 통과)
 *   audit_failed                 → records_updated (관리자 수동 복구)
 *
 * 저장 경로: data/pipeline-ledger/approval-states/{pipelineId}.json
 */

import { writeJsonFile, readJsonFile, fileExists } from "@/lib/github/repository";

// ============================================================
// 타입
// ============================================================

export type ApprovalState =
  | "draft_ready"
  | "waiting_for_user_approval"
  | "approved_pending_record_update"
  | "records_updated"
  | "audit_failed"
  | "released";

export interface ApprovalStateRecord {
  pipelineId: string;
  topicId: string;
  userId: string;
  state: ApprovalState;
  history: Array<{
    from: ApprovalState | null;
    to: ApprovalState;
    reason: string;
    at: string;
    actor: string; // "system" | userId
  }>;
  createdAt: string;
  updatedAt: string;
  // 차단 정보 (audit_failed 상태일 때)
  gateBlockedBy?: string;
  gateBlockedReason?: string;
  gateBlockedAt?: string;
}

// 허용된 전이 맵
const ALLOWED_TRANSITIONS: Record<ApprovalState, ApprovalState[]> = {
  draft_ready:                      ["waiting_for_user_approval"],
  waiting_for_user_approval:        ["approved_pending_record_update", "draft_ready"],
  approved_pending_record_update:   ["records_updated"],
  records_updated:                  ["audit_failed", "released"],
  audit_failed:                     ["records_updated"],   // 관리자 복구
  released:                         [],                    // 최종 상태 — 전이 없음
};

// ============================================================
// 경로
// ============================================================

function statePath(pipelineId: string): string {
  return `data/pipeline-ledger/approval-states/${pipelineId}.json`;
}

// ============================================================
// 읽기 / 쓰기
// ============================================================

export async function getApprovalState(
  pipelineId: string
): Promise<ApprovalStateRecord | null> {
  const path = statePath(pipelineId);
  if (!(await fileExists(path))) return null;
  const { data } = await readJsonFile<ApprovalStateRecord>(path);
  return data;
}

export async function initApprovalState(params: {
  pipelineId: string;
  topicId: string;
  userId: string;
}): Promise<ApprovalStateRecord> {
  const path = statePath(params.pipelineId);
  const now = new Date().toISOString();
  const record: ApprovalStateRecord = {
    pipelineId: params.pipelineId,
    topicId: params.topicId,
    userId: params.userId,
    state: "draft_ready",
    history: [{ from: null, to: "draft_ready", reason: "파이프라인 시작", at: now, actor: "system" }],
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonFile(path, record, `feat: init approval state ${params.pipelineId}`, null);
  return record;
}

export async function transitionApprovalState(params: {
  pipelineId: string;
  to: ApprovalState;
  reason: string;
  actor?: string;
  gateInfo?: { blockedBy?: string; reason?: string };
}): Promise<{ success: boolean; record: ApprovalStateRecord | null; error?: string }> {
  const path = statePath(params.pipelineId);

  if (!(await fileExists(path))) {
    return { success: false, record: null, error: `approval state 없음: ${params.pipelineId}` };
  }

  const { data: record, sha } = await readJsonFile<ApprovalStateRecord>(path);
  const allowed = ALLOWED_TRANSITIONS[record.state];

  if (!allowed.includes(params.to)) {
    return {
      success: false,
      record,
      error: `전이 불가: ${record.state} → ${params.to} (허용: ${allowed.join(", ") || "없음"})`,
    };
  }

  const now = new Date().toISOString();
  const updated: ApprovalStateRecord = {
    ...record,
    state: params.to,
    history: [
      ...record.history,
      { from: record.state, to: params.to, reason: params.reason, at: now, actor: params.actor ?? "system" },
    ],
    updatedAt: now,
    // gate 차단 정보
    ...(params.to === "audit_failed" && params.gateInfo
      ? {
          gateBlockedBy: params.gateInfo.blockedBy,
          gateBlockedReason: params.gateInfo.reason,
          gateBlockedAt: now,
        }
      : {}),
    // released 시 gate 차단 정보 초기화
    ...(params.to === "released"
      ? { gateBlockedBy: undefined, gateBlockedReason: undefined, gateBlockedAt: undefined }
      : {}),
  };

  await writeJsonFile(path, updated, `chore: approval state ${params.pipelineId} → ${params.to}`, sha);
  return { success: true, record: updated };
}

// ============================================================
// 상태 강제 설정 (관리자 복구용)
// ============================================================

export async function forceApprovalState(params: {
  pipelineId: string;
  to: ApprovalState;
  reason: string;
  actor: string;
}): Promise<{ success: boolean; record: ApprovalStateRecord | null; error?: string }> {
  const path = statePath(params.pipelineId);
  if (!(await fileExists(path))) {
    return { success: false, record: null, error: `approval state 없음: ${params.pipelineId}` };
  }

  const { data: record, sha } = await readJsonFile<ApprovalStateRecord>(path);
  const now = new Date().toISOString();

  const updated: ApprovalStateRecord = {
    ...record,
    state: params.to,
    history: [
      ...record.history,
      {
        from: record.state,
        to: params.to,
        reason: `[FORCE] ${params.reason}`,
        at: now,
        actor: params.actor,
      },
    ],
    updatedAt: now,
  };

  await writeJsonFile(path, updated, `admin: force approval state ${params.pipelineId} → ${params.to}`, sha);
  return { success: true, record: updated };
}
