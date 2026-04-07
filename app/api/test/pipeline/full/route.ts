/**
 * GET /api/test/pipeline/full
 *
 * 파이프라인 전 과정 E2E 자동 테스트 (SSE 스트리밍)
 * - 실제 orchestrator 실행 (strategy → auto-approve → writing → eval → complete)
 * - 승인 단계에서 자동으로 approve 처리
 * - 진행 상황을 SSE로 실시간 전송, 최종 결과는 "test_result" 이벤트로 전송
 * - 테스트용으로 생성된 post는 완료 후 삭제 (cleanup=false이면 보존)
 *
 * 쿼리 파라미터:
 *   userId    기본값 "a"
 *   cleanup   "false"이면 생성된 post 보존 (기본 삭제)
 */

import { NextRequest } from "next/server";
import { runPipeline, handleApproval } from "@/lib/agents/orchestrator";
import { readJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { TopicIndex } from "@/lib/types/github-data";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function sse(data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId") ?? "a";
  const cleanup = req.nextUrl.searchParams.get("cleanup") !== "false";
  const startedAt = Date.now();

  const stream = new ReadableStream({
    async start(outerController) {
      function emit(type: string, message: string, extra?: Record<string, unknown>) {
        outerController.enqueue(sse({ type, message, elapsedSec: Math.round((Date.now() - startedAt) / 1000), ...extra }));
      }

      // 연결 즉시 첫 이벤트 전송 (Railway 게이트웨이 타임아웃 방지)
      emit("connected", "E2E 테스트 연결됨 — 파이프라인 준비 중...");

      // Railway keepalive: 5초마다 ping 전송 (무응답 시 연결 끊김 방지)
      const keepalive = setInterval(() => {
        outerController.enqueue(new TextEncoder().encode(": ping\n\n"));
      }, 5_000);

      // 1. 토픽 선택
      emit("setup", "테스트 토픽 선택 중...");
      let testTopicId: string;
      let testTopicTitle: string;

      try {
        const path = Paths.topicsIndex();
        if (!(await fileExists(path))) {
          emit("error", "topics.json 없음");
          outerController.close();
          return;
        }
        const { data: index } = await readJsonFile<TopicIndex>(path);
        const draft = index.topics.find(
          (t) => t.status === "draft" && (!t.assignedUserId || t.assignedUserId.toLowerCase() === userId.toLowerCase())
        );
        if (!draft) {
          emit("error", `userId=${userId}에 배정된 draft 토픽 없음`);
          outerController.close();
          return;
        }
        testTopicId = draft.topicId;
        testTopicTitle = draft.title;
        emit("setup", `토픽 선택 완료: "${testTopicTitle}"`, { topicId: testTopicId });
      } catch (err) {
        emit("error", `토픽 로드 실패: ${String(err)}`);
        outerController.close();
        return;
      }

      // 2. 파이프라인 실행
      emit("pipeline", "파이프라인 실행 시작...");

      let resolved = false;
      let autoApproved = false;
      let pipelineIdCapture = "";
      let finalPostId = "";

      // 자동 승인 폴러
      const autoApproveLoop = setInterval(() => {
        if (pipelineIdCapture && !autoApproved) {
          const ok = handleApproval({ pipelineId: pipelineIdCapture, approved: true });
          if (ok) {
            autoApproved = true;
            emit("approval", `자동 승인 완료 ✅`, { pipelineId: pipelineIdCapture });
            clearInterval(autoApproveLoop);
          }
        }
      }, 300);

      // 파이프라인 SSE 이벤트를 처리하는 내부 controller
      let innerBuffer = "";
      const innerController = {
        enqueue(chunk: Uint8Array) {
          innerBuffer += new TextDecoder().decode(chunk);
          const parts = innerBuffer.split("\n\n");
          innerBuffer = parts.pop() ?? "";

          for (const part of parts) {
            if (!part.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(part.slice(6)) as {
                type: string;
                stage: string;
                data: Record<string, unknown>;
              };

              if (event.data?.pipelineId) {
                pipelineIdCapture = String(event.data.pipelineId);
              }

              if (event.type === "stage_change") {
                emit("stage", `단계 변경 → ${event.stage}`, { stage: event.stage });
              } else if (event.type === "progress") {
                emit("progress", String(event.data?.message ?? ""), { stage: event.stage });
              } else if (event.type === "approval_required") {
                pipelineIdCapture = String(event.data?.pipelineId ?? pipelineIdCapture);
                emit("approval", "승인 요청 수신 — 자동 승인 처리 중...");
              } else if (event.type === "token") {
                // 토큰 스트림은 너무 많아서 스킵 (글자수만 카운트)
              } else if (event.type === "result") {
                if (!resolved) {
                  resolved = true;
                  finalPostId = String(event.data?.postId ?? "");
                  emit("test_result", "✅ 전 과정 완료!", {
                    ok: true,
                    postId: finalPostId,
                    title: event.data?.title,
                    wordCount: event.data?.wordCount,
                    evalScore: event.data?.evalScore,
                    pass: event.data?.pass,
                    totalElapsedSec: Math.round((Date.now() - startedAt) / 1000),
                    cleanup,
                  });
                }
              } else if (event.type === "gate_blocked") {
                if (!resolved) {
                  resolved = true;
                  emit("test_result", `❌ 품질 평가 미달: ${event.data?.evalScore}점`, {
                    ok: false,
                    error: `품질 미달 (${event.data?.evalScore}점)`,
                    evalScore: event.data?.evalScore,
                    totalElapsedSec: Math.round((Date.now() - startedAt) / 1000),
                  });
                }
              } else if (event.type === "error") {
                if (!resolved) {
                  resolved = true;
                  emit("test_result", `❌ 오류: ${event.data?.message}`, {
                    ok: false,
                    error: String(event.data?.message ?? ""),
                    totalElapsedSec: Math.round((Date.now() - startedAt) / 1000),
                  });
                }
              }
            } catch {
              // 파싱 실패 무시
            }
          }
        },
        close() {
          clearInterval(autoApproveLoop);
          clearInterval(keepalive);
          if (!resolved) {
            resolved = true;
            emit("test_result", "❌ 스트림 종료 — 완료 이벤트 미수신", {
              ok: false,
              error: "스트림 비정상 종료",
              totalElapsedSec: Math.round((Date.now() - startedAt) / 1000),
            });
          }
        },
        error(err: unknown) {
          clearInterval(autoApproveLoop);
          clearInterval(keepalive);
          if (!resolved) {
            resolved = true;
            emit("test_result", `❌ 스트림 오류: ${String(err)}`, {
              ok: false,
              error: String(err),
              totalElapsedSec: Math.round((Date.now() - startedAt) / 1000),
            });
          }
        },
        desiredSize: null,
      } as unknown as ReadableStreamDefaultController;

      try {
        await runPipeline({
          request: { topicId: testTopicId, userId },
          controller: innerController,
        });
      } catch (err) {
        clearInterval(autoApproveLoop);
        clearInterval(keepalive);
        if (!resolved) {
          resolved = true;
          emit("test_result", `❌ 파이프라인 예외: ${String(err)}`, {
            ok: false,
            error: String(err),
            totalElapsedSec: Math.round((Date.now() - startedAt) / 1000),
          });
        }
      }

      clearInterval(keepalive);

      // 3. cleanup
      if (cleanup && finalPostId) {
        emit("cleanup", `테스트 포스트 삭제 중... (${finalPostId})`);
        try {
          const base = process.env.RAILWAY_PUBLIC_DOMAIN
            ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
            : "http://localhost:3000";
          await fetch(`${base}/api/github/posts?postId=${finalPostId}`, { method: "DELETE" });
          await fetch(`${base}/api/github/topics`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ topicId: testTopicId, status: "draft" }),
          });
          emit("cleanup", "✅ 테스트 데이터 정리 완료 (post 삭제, topic draft 복구)");
        } catch {
          emit("cleanup", "⚠️ 테스트 데이터 정리 실패 (수동 삭제 필요)");
        }
      }

      outerController.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
