import { NextRequest, NextResponse } from "next/server";
import { getAllArtifacts, getArtifact } from "@/lib/agents/artifact-registry";
import type { ArtifactType } from "@/lib/agents/artifact-registry";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;
  const pipelineId = searchParams.get("pipelineId");
  const type = searchParams.get("type") as ArtifactType | null;

  if (!pipelineId) {
    return NextResponse.json({ error: "pipelineId 파라미터가 필요합니다." }, { status: 400 });
  }

  try {
    if (type) {
      const artifact = await getArtifact(pipelineId, type);
      if (!artifact) {
        return NextResponse.json({ error: `아티팩트를 찾을 수 없습니다: ${type}` }, { status: 404 });
      }
      return NextResponse.json({ artifact });
    }

    const artifacts = await getAllArtifacts(pipelineId);
    return NextResponse.json({ pipelineId, artifacts });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "아티팩트 조회 실패" },
      { status: 500 }
    );
  }
}
