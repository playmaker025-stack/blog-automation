/**
 * Anthropic API 동시 호출 제한 세마포어
 *
 * Railway 단일 인스턴스에서 8명이 동시 파이프라인 실행 시
 * Anthropic API 동시 연결 수를 제한해 부하 분산.
 *
 * MAX_CONCURRENT = 5: 최대 5개 API 호출 동시 진행
 * - 6번째 이후 호출은 대기열에서 순서 대기
 * - 각 호출 평균 20~40s → 8명 기준 큐 대기 최대 ~80s (허용 범위)
 * - QUEUE_TIMEOUT_MS: 큐 대기 한계 초과 시 에러 반환 (Railway 300s 제한 방어)
 */

const MAX_CONCURRENT = 5;
const QUEUE_TIMEOUT_MS = 120_000; // 2분 — 이 이상 대기하면 에러

class AnthropicSemaphore {
  private running = 0;
  private readonly queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];

  private acquire(): Promise<void> {
    if (this.running < MAX_CONCURRENT) {
      this.running++;
      return Promise.resolve();
    }
    // 큐 대기 — QUEUE_TIMEOUT_MS 초과 시 에러
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // 큐에서 자신을 제거
        const idx = this.queue.findIndex((e) => e.resolve === resolve);
        if (idx !== -1) this.queue.splice(idx, 1);
        reject(
          new Error(
            `서버가 요청을 처리 중입니다 (${QUEUE_TIMEOUT_MS / 1000}초 대기 초과). 잠시 후 다시 시도해주세요.`
          )
        );
      }, QUEUE_TIMEOUT_MS);

      this.queue.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject,
      });
    });
  }

  private release(): void {
    if (this.queue.length > 0) {
      // 대기 중인 다음 호출에 슬롯 양보 (running 유지)
      const next = this.queue.shift()!;
      next.resolve();
    } else {
      this.running--;
    }
  }

  /** 세마포어로 감싼 비동기 함수 실행 */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get stats() {
    return { running: this.running, queued: this.queue.length, max: MAX_CONCURRENT };
  }
}

// 모듈 싱글턴 — Next.js HMR에서도 globalThis에 유지
declare global {
  var _anthropicSemaphore: AnthropicSemaphore | undefined;
}

export const anthropicSemaphore: AnthropicSemaphore =
  globalThis._anthropicSemaphore ??
  (globalThis._anthropicSemaphore = new AnthropicSemaphore());
