import { NextRequest, NextResponse } from "next/server";
import { naverKeywordResearch } from "@/lib/skills/naver-keyword-research";

export async function GET(request: NextRequest) {
  const keyword = request.nextUrl.searchParams.get("keyword");
  if (!keyword) {
    return NextResponse.json({ error: "keyword 파라미터가 필요합니다." }, { status: 400 });
  }

  try {
    const result = await naverKeywordResearch({ keyword, display: 30 });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "리서치 실패" },
      { status: 500 }
    );
  }
}
