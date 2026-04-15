/**
 * PipelineRunner — 컴포넌트 생명주기와 독립적인 파이프라인 실행 싱글턴
 *
 * 컴포넌트가 언마운트(다른 메뉴 이동)되어도 SSE 스트림과 실행 상태가
 * 계속 유지된다. 모든 상태는 Zustand store에 기록하므로 컴포넌트가
 * 다시 마운트될 때 이전 상태를 그대로 복원한다.
 *
 * 다중 사용자: 각 브라우저 탭은 독립적인 JS 모듈 인스턴스를 가지므로
 * 자동으로 격리된다.
 */

import { usePipelineStore } from "@/lib/store/pipeline-store";
import type { PipelineApprovalData, PipelineResultData, BatchItemStatus } from "@/lib/store/pipeline-store";
import type { SSEEvent } from "@/lib/agents/types";
import { applyEventToInspector } from "@/components/pipeline/state-inspector";
import type { PipelineStage } from "@/lib/types/agent";

// BatchItemStatus는 pipeline-store에서 정의 후 re-export
export type { BatchItemStatus };

// ── SSE 스트림 읽기 유틸 ────────────────────────────────────────

async function readSSEStream(
  response: Response,
  onEvent: (event: SSEEvent) => void
): Promise<void> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try { onEvent(JSON.parse(line.slice(6)) as SSEEvent); } catch { /* ignore */ }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── PipelineRunner 클래스 ────────────────────────────────────────

class PipelineRunner {
  private batchCancelled = false;

  private store() {
    return usePipelineStore.getState();
  }

  /** SSE 이벤트를 Zustand store에 반영 */
  private applyEvent(event: SSEEvent) {
    const s = this.store();
    s.appendEvent(event);
    s.setInspector((prev) => applyEventToInspector(prev, event));

    if (event.type === "stage_change") {
      s.setStage(
        (event.data as { stage?: PipelineStage })?.stage ?? event.stage
      );
    }
    if (event.type === "token") {
      s.appendStreamingToken((event.data as { token?: string })?.token ?? "");
    }
    if (event.type === "result") {
      const d = event.data as PipelineResultData;
      s.setResult(d);
      s.setRunning(false);
      s.setRunStartedAt(null);
      s.setRunningTitle(null);
    }
    if (event.type === "gate_blocked") {
      const d = event.data as {
        postId: string;
        evalScore: number;
        recommendations: string[];
        draft?: { title: string; wordCount: number };
      };
      s.setStage("gate_blocked");
      s.setResult({
        postId: d.postId,
        title: d.draft?.title ?? "",
        wordCount: d.draft?.wordCount ?? 0,
        evalScore: d.evalScore,
        pass: false,
        recommendations: d.recommendations ?? [],
      });
      s.setRunning(false);
      s.setRunStartedAt(null);
      s.setRunningTitle(null);
    }
    if (event.type === "error") {
      const msg =
        (event.data as { message?: string })?.message ??
        "파이프라인 오류가 발생했습니다.";
      s.setPipelineError(msg);
      s.setStage("idle");
      s.setRunning(false);
      s.setRunStartedAt(null);
      s.setRunningTitle(null);
    }
  }

  /** write phase: strategy 승인 후 본문 생성 */
  private async runWritePhase(ad: PipelineApprovalData, uid: string): Promise<void> {
    try {
      const res = await fetch("/api/pipeline/write", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pipelineId: ad.pipelineId,
          topicId: ad.topicId,
          userId: uid,
          strategy: ad.strategy,
        }),
      });
      if (!res.body) { this.store().setRunning(false); return; }
      await readSSEStream(res, (ev) => this.applyEvent(ev));
      // 스트림 정상 종료 — result 이벤트가 없었다면 running 해제
      const { running } = this.store();
      if (running) this.store().setRunning(false);
    } catch {
      this.store().setRunning(false);
      this.store().setPipelineError("본문 작성 중 오류가 발생했습니다.");
    }
  }

  /**
   * strategy phase 시작.
   * approval_required 이벤트를 받으면 store.approval에 저장하고 반환.
   * 컴포넌트가 autoApprove면 즉시 approve()를 호출하면 된다.
   */
  async start(topicId: string, uid: string, runningTitle: string): Promise<void> {
    const s = this.store();
    s.setRunning(true);
    s.setRunStartedAt(Date.now());
    s.setPipelineError(null);
    s.setApproval(null);
    s.setRunningTitle(runningTitle);

    try {
      const res = await fetch("/api/pipeline/strategy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topicId, userId: uid }),
      });
      if (!res.body) { this.store().setRunning(false); return; }

      let approvalHandled = false;

      await readSSEStream(res, (event) => {
        if (event.type === "approval_required") {
          approvalHandled = true;
          const d = event.data as {
            pipelineId: string;
            previousTitle: string;
            proposedTitle: string;
            rationale: string;
            outline: string[];
            strategy: import("@/lib/agents/types").StrategyPlanResult;
          };
          const approvalData: PipelineApprovalData = {
            pipelineId: d.pipelineId,
            topicId,
            previousTitle: d.previousTitle,
            proposedTitle: d.proposedTitle,
            rationale: d.rationale,
            outline: d.outline,
            strategy: d.strategy,
          };
          this.store().setApproval(approvalData);
          this.store().setInspector((prev) => ({
            ...prev,
            approval_required_emitted: true,
          }));
          // autoApprove 처리는 컴포넌트(또는 approve())에서 담당
        } else {
          this.applyEvent(event);
        }
      });

      // 스트림 종료 — approval 없이 끝났으면 에러로 처리
      if (!approvalHandled && this.store().running) {
        this.store().setRunning(false);
      }
    } catch {
      this.store().setRunning(false);
      this.store().setPipelineError("전략 수립 중 오류가 발생했습니다.");
    }
  }

  /** 전략 승인 → write phase 시작 */
  async approve(uid: string): Promise<void> {
    const s = this.store();
    const ad = s.approval;
    if (!ad) return;
    s.setApproval(null);
    s.setInspector((prev) => ({ ...prev, approval_received: true }));
    await this.runWritePhase(ad, uid);
  }

  /** 전략 거절 → 파이프라인 취소 */
  reject(): void {
    const s = this.store();
    s.setApproval(null);
    s.setRunning(false);
    s.setRunStartedAt(null);
    s.setRunningTitle(null);
    s.setStage("idle");
  }

  // ── 배치: 토픽 1개 순차 실행 (Promise 래핑) ──────────────────

  private async runSingleInBatch(
    topicId: string,
    uid: string
  ): Promise<{ success: boolean; evalScore?: number; wordCount?: number; pass?: boolean }> {
    return new Promise((resolve) => {
      const runWrite = async (ad: PipelineApprovalData) => {
        try {
          const res = await fetch("/api/pipeline/write", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              pipelineId: ad.pipelineId,
              topicId: ad.topicId,
              userId: uid,
              strategy: ad.strategy,
            }),
          });
          if (!res.body) { resolve({ success: false }); return; }
          let settled = false;
          await readSSEStream(res, (ev) => {
            if (settled) return;
            if (ev.type === "result") {
              settled = true;
              const d = ev.data as PipelineResultData;
              resolve({ success: true, evalScore: d.evalScore, wordCount: d.wordCount, pass: d.pass });
            } else if (ev.type === "gate_blocked") {
              settled = true;
              const d = ev.data as { evalScore: number; draft?: { wordCount: number } };
              resolve({ success: true, evalScore: d.evalScore, wordCount: d.draft?.wordCount, pass: false });
            } else if (ev.type === "error") {
              settled = true;
              resolve({ success: false });
            }
          });
          if (!settled) resolve({ success: false });
        } catch {
          resolve({ success: false });
        }
      };

      (async () => {
        try {
          const res = await fetch("/api/pipeline/strategy", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ topicId, userId: uid }),
          });
          if (!res.body) { resolve({ success: false }); return; }
          let approvalHandled = false;
          await readSSEStream(res, (ev) => {
            if (ev.type === "approval_required" && !approvalHandled) {
              approvalHandled = true;
              const d = ev.data as {
                pipelineId: string;
                previousTitle: string;
                proposedTitle: string;
                rationale: string;
                outline: string[];
                strategy: import("@/lib/agents/types").StrategyPlanResult;
              };
              const ad: PipelineApprovalData = {
                pipelineId: d.pipelineId,
                topicId,
                previousTitle: d.previousTitle,
                proposedTitle: d.proposedTitle,
                rationale: d.rationale,
                outline: d.outline,
                strategy: d.strategy,
              };
              runWrite(ad); // fire-and-forget, resolve는 내부에서
            } else if (ev.type === "error") {
              resolve({ success: false });
            }
          });
          if (!approvalHandled) resolve({ success: false });
        } catch {
          resolve({ success: false });
        }
      })();
    });
  }

  /** 배치 실행 */
  async startBatch(
    queue: BatchItemStatus[],
    uid: string,
    onUpdate: (idx: number, update: Partial<BatchItemStatus>) => void
  ): Promise<void> {
    this.batchCancelled = false;
    for (let i = 0; i < queue.length; i++) {
      if (this.batchCancelled) break;
      onUpdate(i, { status: "running" });
      const res = await this.runSingleInBatch(queue[i].topicId, uid);
      onUpdate(i, {
        status: res.success ? "done" : "failed",
        evalScore: res.evalScore,
        wordCount: res.wordCount,
        pass: res.pass,
      });
    }
  }

  /** 배치 중단 */
  stopBatch(): void {
    this.batchCancelled = true;
  }
}

// 모듈 싱글턴 — 컴포넌트 생명주기와 무관하게 존재
export const pipelineRunner = new PipelineRunner();
