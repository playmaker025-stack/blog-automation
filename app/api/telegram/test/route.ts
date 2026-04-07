/**
 * POST /api/telegram/test
 * 텔레그램 봇으로 테스트 메시지 발송
 * body: { chatId: number }
 */

import { NextRequest, NextResponse } from "next/server";
import { sendMessage } from "@/lib/telegram/client";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { chatId?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "JSON 파싱 실패" }, { status: 400 });
  }

  const chatId = body.chatId;
  if (!chatId) {
    return NextResponse.json({ ok: false, error: "chatId가 필요합니다." }, { status: 400 });
  }

  try {
    await sendMessage(
      chatId,
      `✅ <b>테스트 메시지</b>\n\n봇이 정상적으로 작동 중입니다!\n\n사용 가능한 명령어:\n/topics — 글목록 확인\n/write — 글쓰기 시작\n/status — 진행 상태\n/help — 도움말`
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
