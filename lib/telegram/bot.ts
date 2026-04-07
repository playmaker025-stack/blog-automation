/**
 * Telegram 봇 커맨드 핸들러
 *
 * 커맨드:
 *   /start         — 봇 소개
 *   /topics        — 남은 글목록 확인
 *   /write [n]     — n번째 토픽으로 글쓰기 시작 (생략 시 첫 번째)
 *   /status        — 현재 파이프라인 상태
 *   /help          — 도움말
 *
 * 인라인 버튼:
 *   approve:[pipelineId] — 전략 승인
 *   reject:[pipelineId]  — 전략 거절
 */

import { sendMessage, answerCallback, editMessage } from "./client";
import type { TelegramUpdate } from "./client";
import { readJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { TopicIndex, PostingIndex } from "@/lib/types/github-data";
import { resolveRemainingTopics } from "@/lib/skills/remaining-topic-resolver";

// ── 앱 URL 자동 감지 (Railway 우선, 환경 변수 fallback) ──────
function getAppUrl(): string {
  // Railway가 자동 제공하는 도메인 변수 우선 사용
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railwayDomain) return `https://${railwayDomain}`;
  // 명시적 설정값
  const explicit = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (explicit && !explicit.includes("localhost")) return explicit;
  return "http://localhost:3000";
}

// ── 승인 대기 중인 파이프라인 in-memory 저장 ─────────────────
// orchestrator의 pendingApprovals와 연결하기 위한 공유 상태
declare global {
   
  var _telegramPendingApprovals: Map<string, {
    chatId: number;
    messageId?: number;
    pipelineId: string;
    proposedTitle: string;
    rationale: string;
  }> | undefined;
}

export const telegramPendingApprovals: Map<string, {
  chatId: number;
  messageId?: number;
  pipelineId: string;
  proposedTitle: string;
  rationale: string;
}> = globalThis._telegramPendingApprovals ??
  (globalThis._telegramPendingApprovals = new Map());

// ── 기본 userId 설정 저장 ─────────────────────────────────────
declare global {
   
  var _telegramUserMap: Map<number, string> | undefined;
}
const telegramUserMap: Map<number, string> =
  globalThis._telegramUserMap ?? (globalThis._telegramUserMap = new Map());

// ── 메인 디스패처 ─────────────────────────────────────────────

export async function handleTelegramUpdate(update: TelegramUpdate): Promise<void> {
  // 콜백 쿼리 (버튼 클릭)
  if (update.callback_query) {
    await handleCallback(update.callback_query);
    return;
  }

  // 일반 메시지
  if (update.message?.text) {
    const chatId = update.message.chat.id;
    const text = update.message.text.trim();

    if (text.startsWith("/start")) {
      await handleStart(chatId);
    } else if (text.startsWith("/topics") || text === "topics") {
      await handleTopics(chatId);
    } else if (text.startsWith("/write") || text.startsWith("write")) {
      const parts = text.split(/\s+/);
      const arg = parts[1] ?? "";
      await handleWrite(chatId, arg);
    } else if (text.startsWith("/status") || text === "status") {
      await handleStatus(chatId);
    } else if (text.startsWith("/user ")) {
      const userId = text.split(" ")[1]?.trim().toLowerCase() ?? "";
      await handleSetUser(chatId, userId);
    } else if (text.startsWith("/help") || text === "help") {
      await handleHelp(chatId);
    } else {
      await handleHelp(chatId);
    }
  }
}

// ── 커맨드 핸들러 ─────────────────────────────────────────────

async function handleStart(chatId: number) {
  await sendMessage(
    chatId,
    `🤖 <b>Blog Automation Bot</b>\n\n네이버 블로그 글쓰기 자동화 시스템입니다.\n\n<b>커맨드:</b>\n/topics — 남은 글목록\n/write — 글쓰기 시작\n/status — 진행 상태\n/user [id] — 사용자 ID 설정\n/help — 도움말`
  );
}

async function handleHelp(chatId: number) {
  await sendMessage(
    chatId,
    `<b>사용법</b>\n\n/topics — 써야 할 글목록 확인\n/write — 첫 번째 남은 토픽으로 글쓰기\n/write 3 — 3번째 토픽으로 글쓰기\n/user a — 사용자를 a로 설정\n/status — 현재 진행 상태\n\n전략 수립 완료 시 승인/거절 버튼이 전송됩니다.`
  );
}

async function handleSetUser(chatId: number, userId: string) {
  if (!userId || !/^[a-e]$/.test(userId)) {
    await sendMessage(chatId, `❌ 유효하지 않은 사용자 ID입니다. a~e 중 하나를 입력하세요.\n예) /user a`);
    return;
  }
  telegramUserMap.set(chatId, userId);
  await sendMessage(chatId, `✅ 사용자 ID가 <b>${userId}</b>로 설정되었습니다.`);
}

async function handleTopics(chatId: number) {
  try {
    const userId = telegramUserMap.get(chatId) ?? "a";
    await sendMessage(chatId, `⏳ 글목록 불러오는 중...`);

    const topicsPath = Paths.topicsIndex();
    const postsPath = Paths.postingListIndex();

    const [topicsExists, postsExists] = await Promise.all([
      fileExists(topicsPath),
      fileExists(postsPath),
    ]);

    if (!topicsExists) {
      await sendMessage(chatId, `❌ 글목록 파일이 없습니다.`);
      return;
    }

    const { data: topicIndex } = await readJsonFile<TopicIndex>(topicsPath);
    const posts = postsExists
      ? (await readJsonFile<PostingIndex>(postsPath)).data.posts
      : [];

    const userTopics = topicIndex.topics.filter(
      (t) => (t.assignedUserId ?? "").toLowerCase() === userId.toLowerCase()
    );
    const { remaining, matched } = resolveRemainingTopics(userTopics, posts);

    if (remaining.length === 0) {
      await sendMessage(chatId, `✅ <b>사용자 ${userId}</b> — 모든 글이 작성 완료되었습니다!\n총 ${matched.length}개 완료`);
      return;
    }

    const list = remaining
      .slice(0, 10)
      .map((t, i) => `${i + 1}. ${t.title}`)
      .join("\n");

    await sendMessage(
      chatId,
      `📋 <b>사용자 ${userId} 남은 글목록</b>\n남은 ${remaining.length}개 / 완료 ${matched.length}개\n\n${list}${remaining.length > 10 ? `\n... 외 ${remaining.length - 10}개` : ""}\n\n<i>/write [번호]로 작성 시작</i>`
    );
  } catch (e) {
    await sendMessage(chatId, `❌ 오류: ${String(e)}`);
  }
}

async function handleWrite(chatId: number, arg: string) {
  try {
    const userId = telegramUserMap.get(chatId) ?? "a";

    const topicsPath = Paths.topicsIndex();
    const postsPath = Paths.postingListIndex();

    const [topicsExists, postsExists] = await Promise.all([
      fileExists(topicsPath),
      fileExists(postsPath),
    ]);

    if (!topicsExists) {
      await sendMessage(chatId, `❌ 글목록 파일이 없습니다.`);
      return;
    }

    const { data: topicIndex } = await readJsonFile<TopicIndex>(topicsPath);
    const posts = postsExists
      ? (await readJsonFile<PostingIndex>(postsPath)).data.posts
      : [];

    const userTopics = topicIndex.topics.filter(
      (t) => (t.assignedUserId ?? "").toLowerCase() === userId.toLowerCase() && t.status === "draft"
    );
    const { remaining } = resolveRemainingTopics(userTopics, posts);

    if (remaining.length === 0) {
      await sendMessage(chatId, `✅ 사용자 ${userId}의 남은 토픽이 없습니다.`);
      return;
    }

    // 번호로 선택 또는 첫 번째
    const idx = /^\d+$/.test(arg) ? Math.max(0, parseInt(arg) - 1) : 0;
    const topic = remaining[Math.min(idx, remaining.length - 1)];

    await sendMessage(
      chatId,
      `✍️ <b>글쓰기 시작</b>\n\n토픽: <b>${topic.title}</b>\n사용자: ${userId}\n\n⏳ 전략 수립 중... (1~2분 소요)`
    );

    // 파이프라인 API 호출 (비동기 SSE 스트림 시작)
    const appUrl = getAppUrl();

    // SSE 스트리밍을 백그라운드에서 처리
    startPipelineAndNotify({ chatId, topicId: topic.topicId, userId, appUrl }).catch(
      async (err) => {
        await sendMessage(chatId, `❌ 파이프라인 오류: ${String(err)}`).catch(() => {});
      }
    );
  } catch (e) {
    await sendMessage(chatId, `❌ 오류: ${String(e)}`);
  }
}

async function handleStatus(chatId: number) {
  const pending = [...telegramPendingApprovals.values()].filter(
    (p) => p.chatId === chatId
  );

  if (pending.length === 0) {
    await sendMessage(chatId, `ℹ️ 현재 진행 중인 파이프라인이 없습니다.\n\n/write 로 글쓰기를 시작하세요.`);
    return;
  }

  const list = pending
    .map((p) => `• <b>${p.proposedTitle}</b>\n  ID: ${p.pipelineId}\n  승인 대기 중`)
    .join("\n\n");

  await sendMessage(chatId, `📊 <b>진행 중인 파이프라인</b>\n\n${list}`);
}

// ── 콜백 (버튼 클릭) 핸들러 ──────────────────────────────────

async function handleCallback(
  cbq: NonNullable<TelegramUpdate["callback_query"]>
) {
  const chatId = cbq.message?.chat.id ?? cbq.from.id;
  const data = cbq.data ?? "";

  await answerCallback(cbq.id);

  if (data.startsWith("approve:")) {
    const pipelineId = data.replace("approve:", "");
    await handleApprovalResponse(chatId, pipelineId, true, cbq.message?.message_id);
  } else if (data.startsWith("reject:")) {
    const pipelineId = data.replace("reject:", "");
    await handleApprovalResponse(chatId, pipelineId, false, cbq.message?.message_id);
  }
}

async function handleApprovalResponse(
  chatId: number,
  pipelineId: string,
  approved: boolean,
  messageId?: number
) {
  try {
    const appUrl = getAppUrl();

    const res = await fetch(`${appUrl}/api/pipeline/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pipelineId, approved }),
    });

    if (!res.ok) {
      await sendMessage(chatId, `❌ 승인 처리 실패: ${res.status}`);
      return;
    }

    const emoji = approved ? "✅" : "❌";
    const action = approved ? "승인" : "거절";

    if (messageId) {
      await editMessage(
        chatId,
        messageId,
        `${emoji} 전략이 <b>${action}</b>되었습니다.\n파이프라인 ID: ${pipelineId}`
      ).catch(() => {});
    } else {
      await sendMessage(chatId, `${emoji} 전략 ${action} 완료.`);
    }

    telegramPendingApprovals.delete(pipelineId);

    if (approved) {
      await sendMessage(chatId, `✍️ 본문 작성 중입니다... 완료 시 알림을 드립니다.`);
    }
  } catch (e) {
    await sendMessage(chatId, `❌ 오류: ${String(e)}`);
  }
}

// ── 파이프라인 SSE 스트림 처리 ────────────────────────────────

async function startPipelineAndNotify(params: {
  chatId: number;
  topicId: string;
  userId: string;
  appUrl: string;
}): Promise<void> {
  const { chatId, topicId, userId, appUrl } = params;

  const res = await fetch(`${appUrl}/api/pipeline/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topicId, userId }),
  });

  if (!res.ok || !res.body) {
    await sendMessage(chatId, `❌ 파이프라인 시작 실패: ${res.status}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      try {
        const event = JSON.parse(line.slice(6));
        await handlePipelineEvent(chatId, event);
      } catch {
        // JSON 파싱 실패 무시
      }
    }
  }
}

async function handlePipelineEvent(
  chatId: number,
  event: { type: string; stage?: string; data?: Record<string, unknown> }
): Promise<void> {
  const data = event.data ?? {};

  switch (event.type) {
    case "stage_change":
      if (event.stage === "writing") {
        await sendMessage(chatId, `✍️ 본문 작성 시작...`);
      } else if (event.stage === "evaluating") {
        await sendMessage(chatId, `🔍 품질 평가 중...`);
      } else if (event.stage === "complete") {
        await sendMessage(
          chatId,
          `🎉 <b>글쓰기 완료!</b>\n\n제목: <b>${data.title ?? ""}</b>\n글자 수: ${data.wordCount ?? 0}자\n평가 점수: ${data.evalScore ?? "-"}점`
        );
      }
      break;

    case "approval_required": {
      const pipelineId = String(data.pipelineId ?? "");
      const proposedTitle = String(data.proposedTitle ?? "");
      const rationale = String(data.rationale ?? "").slice(0, 200);

      telegramPendingApprovals.set(pipelineId, {
        chatId,
        pipelineId,
        proposedTitle,
        rationale,
      });

      await sendMessage(
        chatId,
        `📋 <b>전략 수립 완료 — 승인 요청</b>\n\n원래 제목: ${data.previousTitle ?? ""}\n제안 제목: <b>${proposedTitle}</b>\n\n근거: ${rationale}\n\n아래 버튼으로 승인 또는 거절하세요.`,
        {
          replyMarkup: {
            inline_keyboard: [
              [
                { text: "✅ 승인", callback_data: `approve:${pipelineId}` },
                { text: "❌ 거절", callback_data: `reject:${pipelineId}` },
              ],
            ],
          },
        }
      );
      break;
    }

    case "rejected":
      await sendMessage(chatId, `🚫 전략이 거절되었습니다.\n수정 후 다시 /write 로 시도하세요.`);
      break;

    case "gate_blocked":
      await sendMessage(
        chatId,
        `⚠️ <b>품질 평가 미달</b>\n\n점수: ${data.evalScore ?? "-"}점\n사유: ${data.reason ?? ""}\n\n초안은 저장되었습니다. 수동 검토 후 다시 시도하세요.`
      );
      break;

    case "error":
      await sendMessage(chatId, `❌ 오류 발생: ${data.message ?? "알 수 없는 오류"}`);
      break;
  }
}
