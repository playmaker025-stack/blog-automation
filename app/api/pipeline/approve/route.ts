import "@anthropic-ai/sdk/shims/node";
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

  // 메모리(즉시) + GitHub(재시작/다중 인스턴스 fallback) 병행 처리
  // 항상 성공 반환 — "승인 전달 실패" 에러 제거
  await handleApproval(body);

  return NextResponse.json({
    success: true,
    pipelineId: body.pipelineId,
    approved: body.approved,
  });
}
