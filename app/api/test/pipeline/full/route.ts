/**
 * GET /api/test/pipeline/full
 *
 * 파이프라인 전 과정 E2E 자동 테스트
 * - 실제 orchestrator를 실행 (strategy → auto-approve → writing → eval → complete)
 * - 승인 단계에서 자동으로 approve 처리
 * - 완료 또는 실패까지 기다린 후 결과 반환
 * - 테스트용이므로 생성된 post는 즉시 삭제
 *
 * 쿼리 파라미터:
 *   userId    기본값 "a"
 *   cleanup   "false"이면 생성된 post 보존 (기본 삭제)
 */

import { NextRequest, NextResponse } from "next/server";
import { runPipeline, handleApproval } from "@/lib/agents/orchestrator";
import { readJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { TopicIndex } from "@/lib/types/github-data";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface StageLog {
  stage: string;
  message: string;
  at: string;
  elapsedMs: number;
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "a";
  const cleanup = req.nextUrl.searchParams.get("cleanup") !== "false";

  const startedAt = Date.now();
  const logs: StageLog[] = [];

  function log(stage: string, message: string) {
    logs.push({ stage, message, at: new Date().toISOString(), elapsedMs: Date.now() - startedAt });
  }

  // 1. 테스트용 draft 토픽 선택
  log("setup", "테스트 토픽 선택 중...");
  let testTopicId: string;
  let testTopicTitle: string;

  try {
    const path = Paths.topicsIndex();
    if (!(await fileExists(path))) {
      return NextResponse.json({ ok: false, error: "topics.json 없음" }, { status: 500 });
    }
    const { data: index } = await readJsonFile<TopicIndex>(path);
    const draft = index.topics.find(
      (t) => t.status === "draft" && (!t.assignedUserId || t.assignedUserId.toLowerCase() === userId.toLowerCase())
    );
    if (!draft) {
      return NextResponse.json({ ok: false, error: `userId=${userId}에 배정된 draft 토픽 없음` }, { status: 400 });
    }
    testTopicId = draft.topicId;
    testTopicTitle = draft.title;
    log("setup", `토픽 선택: "${testTopicTitle}" (${testTopicId})`);
  } catch (err) {
    return NextResponse.json({ ok: false, error: `토픽 로드 실패: ${String(err)}` }, { status: 500 });
  }

  // 2. 파이프라인 실행 — SSE 이벤트를 직접 파싱
  log("pipeline", "파이프라인 시작...");

  const result = await new Promise<{
    ok: boolean;
    postId?: string;
    title?: string;
    wordCount?: number;
    evalScore?: number;
    pass?: boolean;
    error?: string;
    autoApprovedAt?: string;
  }>((resolve) => {
    let buffer = "";
    let autoApproved = false;
    let resolved = false;
    let pipelineIdCapture = "";

    // 자동 승인 폴러 — approval_required 이벤트 후 즉시 handleApproval 호출
    const autoApproveLoop = setInterval(() => {
      if (pipelineIdCapture && !autoApproved) {
        const ok = handleApproval({ pipelineId: pipelineIdCapture, approved: true });
        if (ok) {
          autoApproved = true;
          log("approval", `자동 승인 완료 (pipelineId: ${pipelineIdCapture})`);
          clearInterval(autoApproveLoop);
        }
      }
    }, 200);

    const controller: ReadableStreamDefaultController = {
      enqueue(chunk: Uint8Array) {
        buffer += new TextDecoder().decode(chunk);
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          if (!part.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(part.slice(6)) as {
              type: string;
              stage: string;
              data: Record<string, unknown>;
            };

            // pipelineId 캡처
            if (event.data?.pipelineId) {
              pipelineIdCapture = String(event.data.pipelineId);
            }

            // 단계 로그
            if (event.type === "stage_change") {
              log(event.stage, `단계 진입: ${event.stage}`);
            } else if (event.type === "progress") {
              log(event.stage, String(event.data?.message ?? ""));
            } else if (event.type === "approval_required") {
              pipelineIdCapture = String(event.data?.pipelineId ?? pipelineIdCapture);
              log("awaiting-approval", `승인 요청 수신 — 자동 승인 대기 중...`);
            } else if (event.type === "result") {
              if (!resolved) {
                resolved = true;
                clearInterval(autoApproveLoop);
                resolve({
                  ok: true,
                  postId: String(event.data?.postId ?? ""),
                  title: String(event.data?.title ?? ""),
                  wordCount: Number(event.data?.wordCount ?? 0),
                  evalScore: Number(event.data?.evalScore ?? 0),
                  pass: Boolean(event.data?.pass),
                  autoApprovedAt: autoApproved ? new Date().toISOString() : undefined,
                });
              }
            } else if (event.type === "gate_blocked") {
              if (!resolved) {
                resolved = true;
                clearInterval(autoApproveLoop);
                log("gate_blocked", `품질 평가 미달: ${event.data?.evalScore}점 — ${event.data?.reason ?? ""}`);
                resolve({
                  ok: false,
                  error: `품질 평가 미달: ${event.data?.evalScore}점`,
                  evalScore: Number(event.data?.evalScore ?? 0),
                });
              }
            } else if (event.type === "error") {
              if (!resolved) {
                resolved = true;
                clearInterval(autoApproveLoop);
                resolve({ ok: false, error: String(event.data?.message ?? "알 수 없는 오류") });
              }
            } else if (event.type === "rejected") {
              if (!resolved) {
                resolved = true;
                clearInterval(autoApproveLoop);
                resolve({ ok: false, error: "파이프라인 거절됨 (예상치 못한 동작)" });
              }
            }
          } catch {
            // JSON 파싱 실패 무시
          }
        }
      },
      close() {
        clearInterval(autoApproveLoop);
        if (!resolved) {
          resolved = true;
          resolve({ ok: false, error: "스트림 종료 — 완료 이벤트 미수신" });
        }
      },
      error(err: unknown) {
        clearInterval(autoApproveLoop);
        if (!resolved) {
          resolved = true;
          resolve({ ok: false, error: `스트림 오류: ${String(err)}` });
        }
      },
      desiredSize: null,
    } as unknown as ReadableStreamDefaultController;

    // 타임아웃 280초 (maxDuration 300초보다 작게)
    const timeout = setTimeout(() => {
      clearInterval(autoApproveLoop);
      if (!resolved) {
        resolved = true;
        resolve({ ok: false, error: "E2E 테스트 타임아웃 (280초)" });
      }
    }, 280_000);

    runPipeline({
      request: { topicId: testTopicId, userId },
      controller,
    }).then(() => {
      clearTimeout(timeout);
    }).catch((err) => {
      clearTimeout(timeout);
      clearInterval(autoApproveLoop);
      if (!resolved) {
        resolved = true;
        resolve({ ok: false, error: `파이프라인 예외: ${String(err)}` });
      }
    });
  });

  const totalElapsedMs = Date.now() - startedAt;
  log("done", result.ok ? `완료 — ${result.wordCount}자, eval ${result.evalScore}점` : `실패 — ${result.error}`);

  // 3. cleanup — 생성된 post 삭제 (topic은 복구됨)
  if (cleanup && result.ok && result.postId) {
    try {
      const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : "http://localhost:3000";
      await fetch(`${baseUrl}/api/github/posts?postId=${result.postId}`, { method: "DELETE" });
      log("cleanup", `테스트 포스트 삭제 완료 (${result.postId})`);
    } catch {
      log("cleanup", "테스트 포스트 삭제 실패 (수동 삭제 필요)");
    }
    // topic을 draft로 복구 (완료 후 published로 바뀌었으면)
    try {
      const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
        ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
        : "http://localhost:3000";
      await fetch(`${baseUrl}/api/github/topics`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicId: testTopicId, status: "draft" }),
      });
      log("cleanup", `토픽 draft 복구 완료 (${testTopicId})`);
    } catch {
      log("cleanup", "토픽 복구 실패");
    }
  }

  return NextResponse.json({
    ok: result.ok,
    topic: { id: testTopicId, title: testTopicTitle },
    userId,
    result: result.ok ? {
      postId: result.postId,
      title: result.title,
      wordCount: result.wordCount,
      evalScore: result.evalScore,
      pass: result.pass,
    } : null,
    error: result.ok ? null : result.error,
    totalElapsedMs,
    totalElapsedSec: Math.round(totalElapsedMs / 1000),
    cleanup,
    logs,
  });
}
