import "@anthropic-ai/sdk/shims/node";
import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";

/**
 * Anthropic API 연결 테스트 엔드포인트
 * GET /api/anthropic/ping
 */
export async function GET() {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();

  if (!apiKey) {
    return NextResponse.json(
      { ok: false, error: "ANTHROPIC_API_KEY 환경 변수가 없습니다." },
      { status: 500 }
    );
  }

  const keyPreview = `${apiKey.slice(0, 10)}...${apiKey.slice(-4)}`;

  try {
    const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 15_000 });

    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 16,
      messages: [{ role: "user", content: "ping" }],
    });

    const text =
      response.content.find((b) => b.type === "text")?.text ?? "(no text)";

    return NextResponse.json({
      ok: true,
      keyPreview,
      model: response.model,
      stopReason: response.stop_reason,
      response: text,
      env: {
        TELEGRAM_BOT_TOKEN_exists: "TELEGRAM_BOT_TOKEN" in process.env,
        TELEGRAM_BOT_TOKEN_len: process.env.TELEGRAM_BOT_TOKEN?.trim().length ?? 0,
        NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? null,
        RAILWAY_PUBLIC_DOMAIN: process.env.RAILWAY_PUBLIC_DOMAIN ?? null,
        NODE_ENV: process.env.NODE_ENV,
      },
    });
  } catch (err) {
    const name = err instanceof Error ? err.constructor.name : "UnknownError";
    const message = err instanceof Error ? err.message : String(err);
    const cause =
      err instanceof Error && (err as NodeJS.ErrnoException).cause
        ? String((err as NodeJS.ErrnoException).cause)
        : null;
    const code =
      err instanceof Error ? (err as NodeJS.ErrnoException).code ?? null : null;
    const status = (err as { status?: number }).status ?? null;

    return NextResponse.json(
      { ok: false, keyPreview, name, message, cause, code, status },
      { status: 502 }
    );
  }
}
