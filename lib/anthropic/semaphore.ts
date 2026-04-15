/**
 * Anthropic API 동시 호출 제한 세마포어
 *
 * Railway 단일 인스턴스에서 다중 사용자가 동시 파이프라인 실행 시
 * Anthropic API 동시 연결 수를 제한해 부하 분산.
 *
 * MAX_CONCURRENT = 2: 최대 2개 API 호출 동시 진행
 * - 3번째 이후 호출은 대기열에서 순서 대기
 * - 각 호출 평균 10~30s → 최대 대기 30~60s (허용 범위)
 */

const MAX_CONCURRENT = 2;

class AnthropicSemaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (this.running < MAX_CONCURRENT) {
      this.running++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      // 대기 중인 다음 호출에 슬롯 양보 (running 유지)
      const next = this.queue.shift()!;
      next();
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
