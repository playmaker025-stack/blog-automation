import { NextRequest, NextResponse } from "next/server";
import { readJsonFile, writeJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { BaselineIndex, BaselineResult } from "@/lib/types/github-data";
import { randomUUID } from "crypto";

async function loadIndex(): Promise<{ data: BaselineIndex; sha: string | null }> {
  const path = Paths.evalBaselines();
  if (!(await fileExists(path))) {
    return {
      data: { results: [], lastUpdated: new Date().toISOString() },
      sha: null,
    };
  }
  const { data, sha } = await readJsonFile<BaselineIndex>(path);
  return { data, sha };
}

export async function GET(request: NextRequest) {
  const caseId = request.nextUrl.searchParams.get("caseId");
  try {
    const { data } = await loadIndex();
    const results = caseId
      ? data.results.filter((r) => r.caseId === caseId)
      : data.results;
    return NextResponse.json({ results });
  } catch (err) {
    console.error("[GET /api/github/eval/baselines]", err);
    return NextResponse.json({ error: "베이스라인 조회 실패" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Omit<BaselineResult, "runId">;

    if (!body.caseId || !body.postId || !body.scores) {
      return NextResponse.json(
        { error: "caseId, postId, scores가 필요합니다." },
        { status: 400 }
      );
    }

    const { data: index, sha } = await loadIndex();
    const now = new Date().toISOString();

    const newResult: BaselineResult = {
      runId: `baseline-${randomUUID().slice(0, 8)}`,
      caseId: body.caseId,
      postId: body.postId,
      runAt: now,
      scores: body.scores,
      aggregateScore: body.aggregateScore,
      notes: body.notes ?? "",
    };

    const updated: BaselineIndex = {
      results: [...index.results, newResult],
      lastUpdated: now,
    };

    await writeJsonFile(
      Paths.evalBaselines(),
      updated,
      `feat: add baseline result for case ${newResult.caseId}`,
      sha
    );

    return NextResponse.json({ result: newResult }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/github/eval/baselines]", err);
    return NextResponse.json({ error: "베이스라인 저장 실패" }, { status: 500 });
  }
}
