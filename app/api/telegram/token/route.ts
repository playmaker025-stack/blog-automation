/**
 * POST /api/telegram/token  — 봇 토큰을 GitHub 설정 파일에 저장
 * GET  /api/telegram/token  — 현재 토큰 설정 상태 확인 (토큰 값은 반환 안 함)
 */

import { NextRequest, NextResponse } from "next/server";
import { writeAppConfig, getTelegramToken } from "@/lib/config/app-config";

export const dynamic = "force-dynamic";

/** 토큰 상태 확인 */
export async function GET() {
  const token = await getTelegramToken();
  const source = process.env.TELEGRAM_BOT_TOKEN?.trim()
    ? "env"
    : token
    ? "github-config"
    : "none";

  return NextResponse.json({
    ok: !!token,
    tokenSet: !!token,
    source,
    preview: token ? `${token.slice(0, 8)}...${token.slice(-4)}` : null,
  });
}

/** 토큰 저장 (GitHub 설정 파일) */
export async function POST(req: NextRequest) {
  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSON 파싱 실패" }, { status: 400 });
  }

  const token = body.token?.trim();
  if (!token) {
    return NextResponse.json({ ok: false, error: "token 필드가 필요합니다." }, { status: 400 });
  }

  // 기본 형식 검증: 숫자:문자열
  if (!/^\d+:[A-Za-z0-9_-]{35,}$/.test(token)) {
    return NextResponse.json(
      { ok: false, error: "올바른 Telegram 봇 토큰 형식이 아닙니다. (예: 123456789:ABC...)" },
      { status: 400 }
    );
  }

  try {
    await writeAppConfig({ telegramBotToken: token });
    return NextResponse.json({
      ok: true,
      message: "토큰이 저장되었습니다. /api/telegram/setup?action=register로 웹훅을 등록하세요.",
      preview: `${token.slice(0, 8)}...${token.slice(-4)}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
