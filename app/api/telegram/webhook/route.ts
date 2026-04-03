/**
 * POST /api/telegram/webhook
 * Telegram이 봇 업데이트를 전송하는 엔드포인트
 */

import { NextRequest, NextResponse } from "next/server";
import { handleTelegramUpdate } from "@/lib/telegram/bot";
import type { TelegramUpdate } from "@/lib/telegram/client";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // 보안: 웹훅 시크릿 토큰 검증 (선택)
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (secret) {
    const header = req.headers.get("x-telegram-bot-api-secret-token");
    if (header !== secret) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: TelegramUpdate;
  try {
    body = await req.json() as TelegramUpdate;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // 비동기 처리 (Telegram은 응답을 빠르게 받아야 함)
  handleTelegramUpdate(body).catch((err) => {
    console.error("[telegram/webhook] 처리 오류:", err);
  });

  return NextResponse.json({ ok: true });
}
