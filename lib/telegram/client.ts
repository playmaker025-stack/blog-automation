/**
 * Telegram Bot API 클라이언트
 * 메시지 전송, 인라인 키보드, 알림 기능
 */

import { getTelegramToken } from "@/lib/config/app-config";

async function getBotToken(): Promise<string> {
  const token = await getTelegramToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN이 설정되지 않았습니다. /api/telegram/token으로 설정하세요.");
  return token;
}

export interface TelegramMessage {
  message_id: number;
  from?: { id: number; username?: string; first_name?: string };
  chat: { id: number; type: string };
  text?: string;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    message?: TelegramMessage;
    data?: string;
  };
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

async function apiCall(method: string, body: Record<string, unknown>): Promise<unknown> {
  const token = await getBotToken();
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

/** 텍스트 메시지 전송 */
export async function sendMessage(
  chatId: number,
  text: string,
  options?: {
    parseMode?: "HTML" | "Markdown";
    replyMarkup?: {
      inline_keyboard: InlineKeyboardButton[][];
    };
  }
): Promise<void> {
  await apiCall("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: options?.parseMode ?? "HTML",
    ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
  });
}

/** 기존 메시지 수정 */
export async function editMessage(
  chatId: number,
  messageId: number,
  text: string
): Promise<void> {
  await apiCall("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
  });
}

/** 콜백 쿼리 응답 (버튼 클릭 로딩 표시 제거) */
export async function answerCallback(callbackQueryId: string, text?: string): Promise<void> {
  await apiCall("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

/** 웹훅 등록 */
export async function setWebhook(url: string): Promise<unknown> {
  return apiCall("setWebhook", { url, allowed_updates: ["message", "callback_query"] });
}

/** 웹훅 삭제 */
export async function deleteWebhook(): Promise<unknown> {
  return apiCall("deleteWebhook", {});
}

/** 웹훅 정보 조회 */
export async function getWebhookInfo(): Promise<unknown> {
  const token = await getTelegramToken();
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN이 설정되지 않았습니다.");
  const res = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
  return res.json();
}
