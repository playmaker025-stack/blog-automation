import { NextRequest, NextResponse } from "next/server";
import { readJsonFile, writeJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { EvalCaseIndex, EvalCase } from "@/lib/types/github-data";
import { randomUUID } from "crypto";

async function loadIndex(): Promise<{ data: EvalCaseIndex; sha: string | null }> {
  const path = Paths.evalCasesIndex();
  if (!(await fileExists(path))) {
    return {
      data: { cases: [], lastUpdated: new Date().toISOString() },
      sha: null,
    };
  }
  const { data, sha } = await readJsonFile<EvalCaseIndex>(path);
  return { data, sha };
}

export async function GET() {
  try {
    const { data } = await loadIndex();
    return NextResponse.json({ cases: data.cases });
  } catch (err) {
    console.error("[GET /api/github/eval/cases]", err);
    return NextResponse.json({ error: "eval 케이스 조회 실패" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json() as Partial<EvalCase>;

    if (!body.name || !body.goldenCriteria) {
      return NextResponse.json(
        { error: "name, goldenCriteria가 필요합니다." },
        { status: 400 }
      );
    }

    const totalWeight = body.goldenCriteria.reduce((acc, c) => acc + c.weight, 0);
    if (Math.abs(totalWeight - 1.0) > 0.01) {
      return NextResponse.json(
        { error: `goldenCriteria 가중치 합계가 1이어야 합니다. 현재: ${totalWeight}` },
        { status: 400 }
      );
    }

    const { data: index, sha } = await loadIndex();
    const now = new Date().toISOString();

    const newCase: EvalCase = {
      caseId: `case-${randomUUID().slice(0, 8)}`,
      name: body.name,
      description: body.description ?? "",
      inputTopicId: body.inputTopicId ?? "",
      goldenCriteria: body.goldenCriteria,
      createdAt: now,
    };

    const updated: EvalCaseIndex = {
      cases: [...index.cases, newCase],
      lastUpdated: now,
    };

    await writeJsonFile(
      Paths.evalCasesIndex(),
      updated,
      `feat: add eval case "${newCase.name}"`,
      sha
    );

    return NextResponse.json({ case: newCase }, { status: 201 });
  } catch (err) {
    console.error("[POST /api/github/eval/cases]", err);
    return NextResponse.json({ error: "eval 케이스 생성 실패" }, { status: 500 });
  }
}
