import { NextRequest, NextResponse } from "next/server";
import { readJsonFile, writeJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { UserProfile } from "@/lib/types/github-data";
import { normalizeUserId } from "@/lib/utils/normalize";

export async function GET(request: NextRequest) {
  const rawUserId = request.nextUrl.searchParams.get("userId");
  if (!rawUserId) {
    return NextResponse.json({ error: "userId 파라미터가 필요합니다." }, { status: 400 });
  }
  const userId = normalizeUserId(rawUserId);

  try {
    const path = Paths.userProfile(userId);
    const exists = await fileExists(path);
    if (!exists) {
      return NextResponse.json({ error: "프로필을 찾을 수 없습니다." }, { status: 404 });
    }
    const { data } = await readJsonFile<UserProfile>(path);
    return NextResponse.json({ profile: data });
  } catch (err) {
    console.error("[GET /api/github/profile]", err);
    return NextResponse.json({ error: "프로필 조회 실패" }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json() as { profile: UserProfile };
    const { profile } = body;

    if (!profile?.userId) {
      return NextResponse.json({ error: "userId가 포함된 profile 객체가 필요합니다." }, { status: 400 });
    }

    const path = Paths.userProfile(profile.userId);
    const exists = await fileExists(path);
    let sha: string | null = null;
    if (exists) {
      const { sha: existingSha } = await readJsonFile<UserProfile>(path);
      sha = existingSha;
    }

    const updated: UserProfile = {
      ...profile,
      updatedAt: new Date().toISOString(),
    };

    await writeJsonFile(
      path,
      updated,
      `chore: update profile for ${profile.userId}`,
      sha
    );

    return NextResponse.json({ profile: updated });
  } catch (err) {
    console.error("[PUT /api/github/profile]", err);
    return NextResponse.json({ error: "프로필 저장 실패" }, { status: 500 });
  }
}
