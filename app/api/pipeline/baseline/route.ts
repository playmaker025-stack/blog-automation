import { NextRequest, NextResponse } from "next/server";
import {
  getBaseline,
  saveBaseline,
  compareWithBaseline,
  listBaselineCandidates,
  promoteToBaseline,
} from "@/lib/agents/baseline-manager";
import type { BaselineRecord } from "@/lib/agents/baseline-manager";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;
  const scenarioId = searchParams.get("scenarioId");
  const view = searchParams.get("view"); // "candidates" | undefined

  if (!scenarioId) {
    return NextResponse.json({ error: "scenarioId 파라미터가 필요합니다." }, { status: 400 });
  }

  try {
    if (view === "candidates") {
      const candidates = await listBaselineCandidates(scenarioId);
      return NextResponse.json({ scenarioId, candidates });
    }

    const baseline = await getBaseline(scenarioId);
    return NextResponse.json({ baseline: baseline ?? null });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "베이스라인 조회 실패" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "요청 본문이 유효하지 않습니다." }, { status: 400 });
  }

  const { action, scenarioId } = body as { action: string; scenarioId: string };

  if (!scenarioId) {
    return NextResponse.json({ error: "scenarioId가 필요합니다." }, { status: 400 });
  }

  try {
    // ── 수동 baseline 승격 ──────────────────────────────────
    if (action === "promote") {
      const { runId, promotedBy } = body as { runId: string; promotedBy: string };
      if (!runId) return NextResponse.json({ error: "runId가 필요합니다." }, { status: 400 });
      const result = await promoteToBaseline({
        scenarioId,
        runId,
        promotedBy: promotedBy ?? "user",
      });
      if (!result.success) {
        return NextResponse.json({ error: result.reason }, { status: 400 });
      }
      return NextResponse.json({ promoted: true, record: result.record, reason: result.reason });
    }

    // ── baseline 직접 저장 (관리자용) ──────────────────────
    if (action === "save") {
      const { record } = body as { record: Omit<BaselineRecord, "savedAt"> };
      if (!record) return NextResponse.json({ error: "record가 필요합니다." }, { status: 400 });
      await saveBaseline(scenarioId, record);
      return NextResponse.json({ saved: true });
    }

    // ── baseline vs. current 비교 ───────────────────────────
    if (action === "compare") {
      const { current } = body as {
        current: { runId: string; scores: Record<string, number>; aggregateScore: number };
      };
      if (!current) return NextResponse.json({ error: "current가 필요합니다." }, { status: 400 });
      const baseline = await getBaseline(scenarioId);
      if (!baseline) {
        return NextResponse.json({ error: "베이스라인이 없습니다." }, { status: 404 });
      }
      const diff = compareWithBaseline({ scenarioId, current, baseline });
      return NextResponse.json({ diff });
    }

    return NextResponse.json(
      { error: "action은 promote | save | compare 중 하나여야 합니다." },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "베이스라인 처리 실패" },
      { status: 500 }
    );
  }
}
