/**
 * GET /api/telegram/setup
 * 웹훅 자동 등록 + 현재 상태 확인
 * 배포 후 한 번 호출하면 Telegram이 이 서버로 업데이트를 전송하기 시작함
 */

import { NextRequest, NextResponse } from "next/server";
import { setWebhook, getWebhookInfo } from "@/lib/telegram/client";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "TELEGRAM_BOT_TOKEN 환경 변수가 없습니다." },
      { status: 500 }
    );
  }

  const action = req.nextUrl.searchParams.get("action") ?? "status";

  if (action === "register") {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
    if (!appUrl || appUrl.includes("localhost")) {
      return NextResponse.json(
        { ok: false, error: "NEXT_PUBLIC_APP_URL이 localhost입니다. Railway URL로 설정 후 다시 시도하세요." },
        { status: 400 }
      );
    }

    const webhookUrl = `${appUrl}/api/telegram/webhook`;
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

    const result = await setWebhook(webhookUrl);
    return NextResponse.json({ ok: true, action: "registered", webhookUrl, result });
  }

  // 기본: 현재 웹훅 상태 조회
  const info = await getWebhookInfo();
  return NextResponse.json({ ok: true, action: "status", info });
}
