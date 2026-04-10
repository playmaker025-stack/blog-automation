import "@anthropic-ai/sdk/shims/node";
import { NextRequest, NextResponse } from "next/server";
import { getPipelineState } from "@/lib/agents/orchestrator";

export async function GET(request: NextRequest) {
  const pipelineId = request.nextUrl.searchParams.get("pipelineId");
  if (!pipelineId) {
    return NextResponse.json({ error: "pipelineId 파라미터가 필요합니다." }, { status: 400 });
  }

  const state = getPipelineState(pipelineId);
  if (!state) {
    return NextResponse.json(
      { error: `pipelineId "${pipelineId}"를 찾을 수 없습니다.` },
      { status: 404 }
    );
  }

  return NextResponse.json({ state });
}
