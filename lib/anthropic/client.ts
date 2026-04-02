import Anthropic from "@anthropic-ai/sdk";

let _client: Anthropic | null = null;

export function getAnthropicClient(): Anthropic {
  if (_client) return _client;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY 환경 변수가 설정되지 않았습니다.");
  }

  _client = new Anthropic({ apiKey });
  return _client;
}

export const MODELS = {
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
  opus: "claude-opus-4-6",
} as const;

export type ModelName = keyof typeof MODELS;
