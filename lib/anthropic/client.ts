// Next.js 환경에서 SDK가 web-runtime을 사용하는 문제 방지
// globalThis.fetch가 있으면 SDK가 브라우저로 착각해 node:https agent를 사용하지 않아 "Connection error." 발생
import "@anthropic-ai/sdk/shims/node";
import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (_client) return _client;

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY 환경 변수가 설정되지 않았습니다.");
  }

  _client = new Anthropic({ apiKey, timeout: 120_000, maxRetries: 1 });
  return _client;
}

export const MODELS = {
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  opus: "claude-opus-4-6",
} as const;

export type ModelName = keyof typeof MODELS;
