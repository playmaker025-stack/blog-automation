import { NextRequest, NextResponse } from "next/server";
import { handleApproval } from "@/lib/agents/orchestrator";
import type { ApprovalRequest } from "@/lib/agents/types";

export async function POST(request: NextRequest) {
  let body: ApprovalRequest;
  try {
    body = await request.json() as ApprovalRequest;
  } catch {
    return NextResponse.json({ error: "요청 본문 파싱 실패" }, { status: 400 });
  }

  if (!body.pipelineId || body.approved === undefined) {
    return NextResponse.json(
      { error: "pipelineId와 approved가 필요합니다." },
      { status: 400 }
    );
  }

  const handled = handleApproval(body);
  if (!handled) {
    return NextResponse.json(
      { error: `pipelineId "${body.pipelineId}"를 찾을 수 없거나 이미 처리되었습니다.` },
      { status: 404 }
    );
  }

  return NextResponse.json({
    success: true,
    pipelineId: body.pipelineId,
    approved: body.approved,
  });
}
