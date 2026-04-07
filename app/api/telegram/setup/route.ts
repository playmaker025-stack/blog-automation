/**
 * GET /api/telegram/setup
 * 웹훅 자동 등록 + 현재 상태 확인
 */

import { NextRequest, NextResponse } from "next/server";
import { setWebhook, getWebhookInfo } from "@/lib/telegram/client";
import { getTelegramToken } from "@/lib/config/app-config";

export const dynamic = "force-dynamic";

function getAppUrl(): string {
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railwayDomain) return `https://${railwayDomain}`;
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit && !explicit.includes("localhost")) return explicit;
  return "";
}

export async function GET(req: NextRequest) {
  const token = await getTelegramToken();
  const action = req.nextUrl.searchParams.get("action") ?? "status";

  // 상태 조회는 토큰 없어도 진단 정보 반환
  if (action === "status") {
    const appUrl = getAppUrl();
    const info = token ? await getWebhookInfo().catch(() => null) : null;
    return NextResponse.json({
      ok: !!token,
      tokenSet: !!token,
      tokenSource: process.env.TELEGRAM_BOT_TOKEN?.trim() ? "env" : (token ? "github-config" : "none"),
      appUrl: appUrl || null,
      railwayDomain: process.env.RAILWAY_PUBLIC_DOMAIN?.trim() ?? null,
      nextPublicAppUrl: process.env.NEXT_PUBLIC_APP_URL?.trim() ?? null,
      info,
    });
  }

  if (!token) {
    return NextResponse.json(
      { ok: false, error: "TELEGRAM_BOT_TOKEN이 없습니다. POST /api/telegram/token으로 설정하세요." },
      { status: 500 }
    );
  }

  if (action === "register") {
    const appUrl = getAppUrl();
    if (!appUrl) {
      return NextResponse.json(
        { ok: false, error: "RAILWAY_PUBLIC_DOMAIN 또는 NEXT_PUBLIC_APP_URL이 필요합니다." },
        { status: 400 }
      );
    }

    const webhookUrl = `${appUrl}/api/telegram/webhook`;
    const result = await setWebhook(webhookUrl);
    return NextResponse.json({ ok: true, action: "registered", webhookUrl, result });
  }

  return NextResponse.json({ ok: false, error: `알 수 없는 action: ${action}` }, { status: 400 });
}
