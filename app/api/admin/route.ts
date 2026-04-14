/**
 * 관리자 복구 API
 *
 * 인증: Authorization: Bearer <ADMIN_API_KEY> 헤더 필수
 *
 * GET /api/admin?action=quality_report
 * GET /api/admin?action=logs[&type=...][&pipelineId=...][&limit=...]
 *
 * POST /api/admin
 *   action: "force_stop"           — run 강제 중단
 *   action: "recover_approval"     — approval 상태 수동 복구
 *   action: "discard_candidate"    — baseline candidate 폐기
 */

import { NextRequest, NextResponse } from "next/server";
import { forceApprovalState } from "@/lib/agents/approval-state-machine";
import { getQualityReport, getLogEntries } from "@/lib/agents/operation-logger";
import { upsertLedgerEntry, getLedgerEntry } from "@/lib/agents/pipeline-ledger";
import { writeJsonFile, readJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { TopicIndex } from "@/lib/types/github-data";
import type { ApprovalState } from "@/lib/agents/approval-state-machine";

// ============================================================
// 인증
// ============================================================

function authenticate(request: NextRequest): { ok: true } | { ok: false; response: NextResponse } {
  const key = process.env.ADMIN_API_KEY;
  if (!key) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: "서버 설정 오류: ADMIN_API_KEY가 설정되지 않았습니다." },
        { status: 500 }
      ),
    };
  }
  const auth = request.headers.get("Authorization");
  if (auth !== `Bearer ${key}`) {
    return {
      ok: false,
      response: NextResponse.json({ error: "인증 실패: 유효하지 않은 API 키입니다." }, { status: 401 }),
    };
  }
  return { ok: true };
}

// ============================================================
// 감사 로그 (admin audit — rolling 없이 전체 보존)
// ============================================================

const ADMIN_AUDIT_PATH = "data/pipeline-ledger/admin-audit.json";

interface AdminAuditEntry {
  action: string;
  pipelineId: string;
  actor: string;
  params: Record<string, unknown>;
  result: "success" | "error";
  detail: string;
  at: string;
}

async function appendAdminAudit(entry: AdminAuditEntry): Promise<void> {
  try {
    let entries: AdminAuditEntry[] = [];
    let sha: string | null = null;

    if (await fileExists(ADMIN_AUDIT_PATH)) {
      const { data, sha: fileSha } = await readJsonFile<{ entries: AdminAuditEntry[] }>(ADMIN_AUDIT_PATH);
      entries = data.entries;
      sha = fileSha;
    }

    await writeJsonFile(
      ADMIN_AUDIT_PATH,
      { entries: [...entries, entry], lastUpdated: entry.at },
      `admin-audit: ${entry.action} pipeline=${entry.pipelineId} actor=${entry.actor}`,
      sha
    );
  } catch {
    // 감사 로그 실패는 관리자 작업을 중단시키지 않음
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const { searchParams } = request.nextUrl;
  const action = searchParams.get("action");

  // 품질 리포트 조회
  if (action === "quality_report") {
    const report = await getQualityReport();
    return NextResponse.json({ report });
  }

  // 운영 로그 조회
  if (action === "logs") {
    const type = searchParams.get("type");
    const pipelineId = searchParams.get("pipelineId");
    const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : 50;
    const entries = await getLogEntries({
      type: (type ?? undefined) as import("@/lib/agents/operation-logger").LogEntryType | undefined,
      pipelineId: pipelineId ?? undefined,
      limit,
    });
    return NextResponse.json({ entries, total: entries.length });
  }

  // 감사 로그 조회
  if (action === "audit") {
    if (!(await fileExists(ADMIN_AUDIT_PATH))) {
      return NextResponse.json({ entries: [], total: 0 });
    }
    const { data } = await readJsonFile<{ entries: AdminAuditEntry[] }>(ADMIN_AUDIT_PATH);
    const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : 100;
    const entries = data.entries.slice(-limit);
    return NextResponse.json({ entries, total: data.entries.length });
  }

  return NextResponse.json({ error: "action 파라미터가 필요합니다." }, { status: 400 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문이 유효하지 않습니다." }, { status: 400 });
  }

  const { action, pipelineId, actor = "admin" } = body as {
    action: string;
    pipelineId: string;
    actor?: string;
  };

  if (!pipelineId) {
    return NextResponse.json({ error: "pipelineId가 필요합니다." }, { status: 400 });
  }

  const auditBase = { action, pipelineId, actor, at: new Date().toISOString() };

  try {
    // ── run 강제 중단 ────────────────────────────────────────
    if (action === "force_stop") {
      const entry = await getLedgerEntry(pipelineId);
      if (!entry) {
        return NextResponse.json({ error: `pipeline을 찾을 수 없습니다: ${pipelineId}` }, { status: 404 });
      }
      if (entry.stage === "complete" || entry.stage === "failed" || entry.stage === "gate_blocked") {
        return NextResponse.json({ error: `이미 종료된 pipeline입니다 (stage: ${entry.stage})` }, { status: 400 });
      }

      const stoppedAt = new Date().toISOString();
      await upsertLedgerEntry({
        ...entry,
        stage: "failed",
        error: `[관리자 강제 중단] actor: ${actor}`,
        createdAt: entry.createdAt,
      });

      await forceApprovalState({
        pipelineId,
        to: "draft_ready",
        reason: `관리자 강제 중단 (actor: ${actor})`,
        actor,
      }).catch(() => {});

      await appendAdminAudit({
        ...auditBase,
        params: { previousStage: entry.stage },
        result: "success",
        detail: `force_stop — previousStage: ${entry.stage}`,
      });

      return NextResponse.json({
        stopped: true,
        pipelineId,
        previousStage: entry.stage,
        stoppedAt,
      });
    }

    // ── approval 상태 수동 복구 ──────────────────────────────
    if (action === "recover_approval") {
      const { targetState, reason } = body as { targetState: ApprovalState; reason: string };
      if (!targetState) {
        return NextResponse.json({ error: "targetState가 필요합니다." }, { status: 400 });
      }

      const result = await forceApprovalState({
        pipelineId,
        to: targetState,
        reason: reason ?? `관리자 수동 복구 (actor: ${actor})`,
        actor,
      });

      if (!result.success) {
        await appendAdminAudit({
          ...auditBase,
          params: { targetState, reason },
          result: "error",
          detail: result.error ?? "전이 실패",
        });
        return NextResponse.json({ error: result.error }, { status: 400 });
      }

      await appendAdminAudit({
        ...auditBase,
        params: { targetState, reason },
        result: "success",
        detail: `recover_approval → ${targetState}`,
      });

      return NextResponse.json({
        recovered: true,
        pipelineId,
        newState: targetState,
        record: result.record,
      });
    }

    // ── baseline candidate 폐기 ──────────────────────────────
    if (action === "discard_candidate") {
      const { scenarioId, runId } = body as { scenarioId: string; runId: string };
      if (!scenarioId || !runId) {
        return NextResponse.json({ error: "scenarioId와 runId가 필요합니다." }, { status: 400 });
      }

      const CANDIDATES_PATH = `evals/baselines/${scenarioId}/candidates.json`;
      if (!(await fileExists(CANDIDATES_PATH))) {
        return NextResponse.json({ error: "candidate 목록이 없습니다." }, { status: 404 });
      }

      const { data: candidates, sha } = await readJsonFile<unknown[]>(CANDIDATES_PATH);
      const before = candidates.length;
      const filtered = candidates.filter(
        (c: unknown) => (c as { runId: string }).runId !== runId
      );

      if (filtered.length === before) {
        return NextResponse.json({ error: `candidate를 찾을 수 없습니다: ${runId}` }, { status: 404 });
      }

      await writeJsonFile(
        CANDIDATES_PATH,
        filtered,
        `admin: discard candidate ${runId} (actor: ${actor})`,
        sha
      );

      await appendAdminAudit({
        ...auditBase,
        params: { scenarioId, runId },
        result: "success",
        detail: `discard_candidate runId=${runId} scenarioId=${scenarioId}`,
      });

      return NextResponse.json({
        discarded: true,
        scenarioId,
        runId,
        remainingCount: filtered.length,
      });
    }

    // ── 멈춤 토픽 일괄 복구 (in-progress → draft) ───────────────
    if (action === "recover_stuck_topics") {
      const topicsPath = Paths.topicsIndex();
      if (!(await fileExists(topicsPath))) {
        return NextResponse.json({ error: "topics index가 없습니다." }, { status: 404 });
      }
      const { data: index, sha } = await readJsonFile<TopicIndex>(topicsPath);
      const stuck = index.topics.filter((t) => t.status === "in-progress");
      if (stuck.length === 0) {
        return NextResponse.json({ recovered: 0, message: "멈춤 토픽 없음" });
      }
      const now = new Date().toISOString();
      const updated: TopicIndex = {
        topics: index.topics.map((t) =>
          t.status === "in-progress" ? { ...t, status: "draft", updatedAt: now } : t
        ),
        lastUpdated: now,
      };
      await writeJsonFile(
        topicsPath,
        updated,
        `admin: recover ${stuck.length} stuck topics → draft (actor: ${actor}) [skip ci]`,
        sha
      );
      await appendAdminAudit({
        ...auditBase,
        params: { stuckCount: stuck.length, topicIds: stuck.map((t) => t.topicId) },
        result: "success",
        detail: `recover_stuck_topics: ${stuck.length}개 → draft 복구`,
      });
      return NextResponse.json({
        recovered: stuck.length,
        topicIds: stuck.map((t) => t.topicId),
        titles: stuck.map((t) => t.title),
      });
    }

    return NextResponse.json(
      { error: "action은 force_stop | recover_approval | discard_candidate | recover_stuck_topics 중 하나여야 합니다." },
      { status: 400 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "관리자 작업 실패";
    await appendAdminAudit({
      ...auditBase,
      params: {},
      result: "error",
      detail: message,
    }).catch(() => {});
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
