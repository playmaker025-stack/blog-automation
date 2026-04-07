/**
 * 앱 설정 읽기/쓰기 (GitHub 데이터 레포 기반)
 * Railway 환경변수 주입 실패 시 fallback으로 사용
 */

import { readJsonFile, writeJsonFile } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";

export interface AppConfig {
  telegramBotToken?: string;
  adminChatIds?: number[];
}

const DEFAULT_CONFIG: AppConfig = {};

/** GitHub 데이터 레포에서 앱 설정 읽기 */
export async function readAppConfig(): Promise<AppConfig> {
  try {
    const { data } = await readJsonFile<AppConfig>(Paths.appConfig());
    return data;
  } catch {
    return DEFAULT_CONFIG;
  }
}

/** GitHub 데이터 레포에 앱 설정 저장 */
export async function writeAppConfig(patch: Partial<AppConfig>): Promise<void> {
  let sha: string | null = null;
  let current: AppConfig = DEFAULT_CONFIG;

  try {
    const result = await readJsonFile<AppConfig>(Paths.appConfig());
    current = result.data;
    sha = result.sha;
  } catch {
    // 파일 없으면 신규 생성
  }

  const updated = { ...current, ...patch };
  await writeJsonFile(Paths.appConfig(), updated, "chore: 앱 설정 업데이트 [skip ci]", sha);
}

/** Telegram 봇 토큰 가져오기 (env var → GitHub config 순서로 fallback) */
export async function getTelegramToken(): Promise<string | null> {
  const envToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  if (envToken) return envToken;

  // env var 없으면 GitHub 설정 파일에서 읽기
  const config = await readAppConfig();
  return config.telegramBotToken ?? null;
}
