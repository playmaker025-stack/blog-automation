/**
 * release-gate — pre-write gate + post-audit gate 2단계
 *
 * pre-write gate  (본문 작성 직전)
 *   1. insufficient_grounding   — source_status 불충분
 *   2. approval_missing         — approval_required인데 응답 없음
 *   3. material_change_unsynced — material_change인데 posting-list 미반영
 *
 * post-audit gate (eval 완료 후)
 *   4. audit_not_approved       — eval 점수 기준 미달
 *
 * runReleaseGate = pre-write + post-audit 통합 (하위 호환)
 */

import type { SourceReportData, ApprovalRequestData, RecordUpdateData } from "./artifact-registry";

// ============================================================
// Gate 조건 타입
// ============================================================

export type GateCondition =
  | "insufficient_grounding"
  | "approval_missing"
  | "material_change_unsynced"
  | "audit_not_approved";

export interface GateCheckResult {
  passed: boolean;
  blockedBy: GateCondition | null;
  reason: string;
  details: Partial<Record<GateCondition, string>>;
  gate: "pre-write" | "post-audit" | "combined";
}

// ============================================================
// 개별 조건 검사 함수 (순수 함수)
// ============================================================

export function checkSourceGrounding(
  sourceReport: SourceReportData | null
): { pass: boolean; reason: string } {
  if (!sourceReport) return { pass: true, reason: "source report 없음 — skip" };
  if (sourceReport.groundingStatus === "insufficient_grounding") {
    return {
      pass: false,
      reason: `소스 접근 불충분: ${sourceReport.accessibleCount}/${sourceReport.totalCount}개 접근 가능`,
    };
  }
  return { pass: true, reason: `소스 grounding 충분 (${sourceReport.groundingStatus})` };
}

export function checkApprovalCompleted(
  approvalRequest: ApprovalRequestData | null
): { pass: boolean; reason: string } {
  if (!approvalRequest) return { pass: true, reason: "approval request 없음 — skip" };
  if (approvalRequest.response.respondedAt === null) {
    return { pass: false, reason: "승인 요청이 발행됐으나 사용자 응답을 받지 못했습니다." };
  }
  if (!approvalRequest.response.approved) {
    return {
      pass: false,
      reason: `사용자가 전략을 거절했습니다.${approvalRequest.response.modifications ? ` 수정 요청: ${approvalRequest.response.modifications}` : ""}`,
    };
  }
  return { pass: true, reason: "사용자 승인 완료" };
}

export function checkMaterialChangeSynced(
  approvalRequest: ApprovalRequestData | null,
  recordUpdate: RecordUpdateData | null
): { pass: boolean; reason: string } {
  if (!approvalRequest?.materialChange) {
    return { pass: true, reason: "material_change 없음 — skip" };
  }
  if (!recordUpdate?.postingListUpdated) {
    return {
      pass: false,
      reason: "material_change가 발생했으나 posting-list가 아직 업데이트되지 않았습니다.",
    };
  }
  return { pass: true, reason: "material_change 후 posting-list 업데이트 확인" };
}

export function checkAuditApproved(
  auditReport: { pass: boolean; aggregateScore: number } | null,
  minScore = 70
): { pass: boolean; reason: string } {
  if (!auditReport) return { pass: true, reason: "audit report 없음 — skip" };
  if (!auditReport.pass || auditReport.aggregateScore < minScore) {
    return {
      pass: false,
      reason: `eval 점수 미달: ${auditReport.aggregateScore}점 (기준: ${minScore}점)`,
    };
  }
  return { pass: true, reason: `eval 통과: ${auditReport.aggregateScore}점` };
}

// ============================================================
// pre-write gate (조건 1-3)
// ============================================================

export function runPreWriteGate(params: {
  sourceReport: SourceReportData | null;
  approvalRequest: ApprovalRequestData | null;
  recordUpdate: RecordUpdateData | null;
}): GateCheckResult {
  const checks: Array<{ condition: GateCondition; result: { pass: boolean; reason: string } }> = [
    { condition: "insufficient_grounding", result: checkSourceGrounding(params.sourceReport) },
    { condition: "approval_missing", result: checkApprovalCompleted(params.approvalRequest) },
    { condition: "material_change_unsynced", result: checkMaterialChangeSynced(params.approvalRequest, params.recordUpdate) },
  ];

  const details: Partial<Record<GateCondition, string>> = {};
  for (const { condition, result } of checks) {
    details[condition] = result.reason;
    if (!result.pass) {
      return { passed: false, blockedBy: condition, reason: result.reason, details, gate: "pre-write" };
    }
  }
  return { passed: true, blockedBy: null, reason: "pre-write gate 통과", details, gate: "pre-write" };
}

// ============================================================
// post-audit gate (조건 4)
// ============================================================

export function runPostAuditGate(params: {
  auditReport: { pass: boolean; aggregateScore: number } | null;
  minScore?: number;
}): GateCheckResult {
  const result = checkAuditApproved(params.auditReport, params.minScore);
  const details: Partial<Record<GateCondition, string>> = {
    audit_not_approved: result.reason,
  };
  if (!result.pass) {
    return { passed: false, blockedBy: "audit_not_approved", reason: result.reason, details, gate: "post-audit" };
  }
  return { passed: true, blockedBy: null, reason: "post-audit gate 통과", details, gate: "post-audit" };
}

// ============================================================
// 통합 gate (하위 호환 — pre-write + post-audit 순서대로)
// ============================================================

export function runReleaseGate(params: {
  sourceReport: SourceReportData | null;
  approvalRequest: ApprovalRequestData | null;
  recordUpdate: RecordUpdateData | null;
  auditReport: { pass: boolean; aggregateScore: number } | null;
  skipAuditGate?: boolean;
}): GateCheckResult {
  const preResult = runPreWriteGate({
    sourceReport: params.sourceReport,
    approvalRequest: params.approvalRequest,
    recordUpdate: params.recordUpdate,
  });
  if (!preResult.passed) {
    return { ...preResult, gate: "combined" };
  }

  if (!params.skipAuditGate) {
    const postResult = runPostAuditGate({ auditReport: params.auditReport });
    if (!postResult.passed) {
      return { ...postResult, gate: "combined" };
    }
    return {
      passed: true,
      blockedBy: null,
      reason: "모든 gate 조건 통과",
      details: { ...preResult.details, ...postResult.details },
      gate: "combined",
    };
  }

  return {
    passed: true,
    blockedBy: null,
    reason: "모든 gate 조건 통과 (audit gate 생략)",
    details: preResult.details,
    gate: "combined",
  };
}
