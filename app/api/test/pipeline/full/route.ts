/**
 * GET /api/test/pipeline/full
 *
 * 파이프라인 전 과정 E2E 자동 테스트
 * - 실제 orchestrator 실행 (strategy → auto-approve → writing → eval → complete)
 * - 승인 단계에서 자동으로 approve 처리
 * - 결과를 GitHub data/test-results/latest.json에 저장
 * - 즉시 202 Accepted 반환, 완료 후 GET ?action=result로 결과 조회
 *
 * GET ?action=start   — 테스트 비동기 시작
 * GET ?action=result  — 마지막 테스트 결과 조회
 *
 * 쿼리 파라미터:
 *   userId    기본값 "a"
 *   cleanup   "false"이면 생성된 post 보존 (기본 삭제)
 */

import "@anthropic-ai/sdk/shims/node";
import { NextRequest, NextResponse } from "next/server";
import { runPipeline, handleApproval } from "@/lib/agents/orchestrator";
import { readJsonFile, writeJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { TopicIndex } from "@/lib/types/github-data";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const RESULT_PATH = "data/test-results/latest.json";

interface TestResult {
  status: "running" | "ok" | "failed";
  startedAt: string;
  completedAt?: string;
  totalElapsedSec?: number;
  userId: string;
  topic?: { id: string; title: string };
  result?: {
    postId: string;
    title: string;
    wordCount: number;
    evalScore: number;
    pass: boolean;
  };
  error?: string;
  logs: { stage: string; message: string; elapsedSec: number }[];
}

export async function GET(req: NextRequest) {
  const action = req.nextUrl.searchParams.get("action") ?? "start";
  const userId = req.nextUrl.searchParams.get("userId") ?? "a";
  const cleanup = req.nextUrl.searchParams.get("cleanup") !== "false";

  // 결과 조회
  if (action === "result") {
    try {
      if (!(await fileExists(RESULT_PATH))) {
        return NextResponse.json({ ok: false, error: "테스트 결과 없음 — ?action=start로 먼저 실행하세요." });
      }
      const { data } = await readJsonFile<TestResult>(RESULT_PATH);
      return NextResponse.json(data);
    } catch (err) {
      return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
    }
  }

  // 테스트 시작 — 즉시 실행 (Railway maxDuration 300초 내)
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const logs: TestResult["logs"] = [];

  function log(stage: string, message: string) {
    logs.push({ stage, message, elapsedSec: Math.round((Date.now() - startMs) / 1000) });
    console.log(`[E2E ${stage}] ${message}`);
  }

  // 진행 중 상태 저장
  await writeJsonFile<TestResult>(RESULT_PATH, {
    status: "running", startedAt, userId, logs,
  }, "chore: E2E 테스트 시작 [skip ci]", null).catch(() => {});

  log("setup", "E2E 테스트 시작");

  // 토픽 선택
  let testTopicId: string;
  let testTopicTitle: string;

  try {
    const path = Paths.topicsIndex();
    if (!(await fileExists(path))) throw new Error("topics.json 없음");
    const { data: index } = await readJsonFile<TopicIndex>(path);
    const draft = index.topics.find(
      (t) => t.status === "draft" && (!t.assignedUserId || t.assignedUserId.toLowerCase() === userId.toLowerCase())
    );
    if (!draft) throw new Error(`userId=${userId}에 draft 토픽 없음`);
    testTopicId = draft.topicId;
    testTopicTitle = draft.title;
    log("setup", `토픽: "${testTopicTitle}"`);
  } catch (err) {
    const result: TestResult = { status: "failed", startedAt, completedAt: new Date().toISOString(), totalElapsedSec: 0, userId, error: String(err), logs };
    await writeJsonFile<TestResult>(RESULT_PATH, result, "chore: E2E 테스트 실패 [skip ci]", null).catch(() => {});
    return NextResponse.json(result, { status: 500 });
  }

  // 파이프라인 실행 (동기 — Railway maxDuration 300초 내에서 완료)
  let finalPostId = "";
  let pipelineResult: TestResult["result"] | null = null;
  let pipelineError: string | null = null;

  let resolved = false;
  let autoApproved = false;
  let pipelineIdCapture = "";

  const autoApproveLoop = setInterval(() => {
    if (pipelineIdCapture && !autoApproved) {
      autoApproved = true;
      log("approval", `자동 승인 완료 (${pipelineIdCapture})`);
      clearInterval(autoApproveLoop);
      void handleApproval({ pipelineId: pipelineIdCapture, approved: true });
    }
  }, 300);

  let innerBuffer = "";
  const innerController = {
    enqueue(chunk: Uint8Array) {
      innerBuffer += new TextDecoder().decode(chunk);
      const parts = innerBuffer.split("\n\n");
      innerBuffer = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(part.slice(6)) as { type: string; stage: string; data: Record<string, unknown> };
          if (event.data?.pipelineId) pipelineIdCapture = String(event.data.pipelineId);
          if (event.type === "stage_change") log(event.stage, `단계: ${event.stage}`);
          else if (event.type === "progress") log(event.stage, String(event.data?.message ?? ""));
          else if (event.type === "approval_required") {
            pipelineIdCapture = String(event.data?.pipelineId ?? pipelineIdCapture);
            log("approval", "승인 요청 — 자동 승인 대기");
          } else if (event.type === "result") {
            if (!resolved) {
              resolved = true;
              finalPostId = String(event.data?.postId ?? "");
              pipelineResult = {
                postId: finalPostId,
                title: String(event.data?.title ?? ""),
                wordCount: Number(event.data?.wordCount ?? 0),
                evalScore: Number(event.data?.evalScore ?? 0),
                pass: Boolean(event.data?.pass),
              };
              log("complete", `완료: ${pipelineResult.wordCount}자, eval ${pipelineResult.evalScore}점`);
            }
          } else if (event.type === "gate_blocked") {
            if (!resolved) { resolved = true; pipelineError = `품질 미달 (${event.data?.evalScore}점)`; }
          } else if (event.type === "error") {
            if (!resolved) { resolved = true; pipelineError = String(event.data?.message ?? "알 수 없는 오류"); }
          }
        } catch { /* ignore */ }
      }
    },
    close() { clearInterval(autoApproveLoop); },
    error(_err: unknown) { clearInterval(autoApproveLoop); },
    desiredSize: null,
  } as unknown as ReadableStreamDefaultController;

  try {
    await runPipeline({ request: { topicId: testTopicId, userId }, controller: innerController });
  } catch (err) {
    clearInterval(autoApproveLoop);
    pipelineError = String(err);
  }

  clearInterval(autoApproveLoop);

  const completedAt = new Date().toISOString();
  const totalElapsedSec = Math.round((Date.now() - startMs) / 1000);

  // cleanup
  if (cleanup && finalPostId) {
    try {
      const base = process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "http://localhost:3000";
      await fetch(`${base}/api/github/posts?postId=${finalPostId}`, { method: "DELETE" });
      await fetch(`${base}/api/github/topics`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ topicId: testTopicId, status: "draft" }) });
      log("cleanup", "post 삭제 + topic draft 복구 완료");
    } catch { log("cleanup", "cleanup 실패 (수동 확인 필요)"); }
  }

  const finalResult: TestResult = pipelineResult
    ? { status: "ok", startedAt, completedAt, totalElapsedSec, userId, topic: { id: testTopicId, title: testTopicTitle }, result: pipelineResult, logs }
    : { status: "failed", startedAt, completedAt, totalElapsedSec, userId, topic: { id: testTopicId, title: testTopicTitle }, error: pipelineError ?? "완료 이벤트 미수신", logs };

  await writeJsonFile<TestResult>(RESULT_PATH, finalResult, "chore: E2E 테스트 결과 저장 [skip ci]", null).catch(() => {});

  return NextResponse.json(finalResult, { status: finalResult.status === "ok" ? 200 : 500 });
}
