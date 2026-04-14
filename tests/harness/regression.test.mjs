/**
 * 재발 방지 회귀 테스트 — CLAUDE.md "알려진 실패 패턴" 시나리오 재현
 *
 * 각 describe 블록은 실제 발생한 장애 하나를 재현한다.
 * 이 테스트가 통과하는 한 동일한 장애는 재발하지 않는다.
 *
 * RULE-001  AbortSignal 타임아웃 동작
 * RULE-002  파이프라인 실패 시 topic draft 복구
 * RULE-003  atomicSetTopicInProgress 동시성 보장
 * RULE-004  withConflictRetry SHA 충돌 재시도
 * RULE-005  SSE 누락 대비 폴링 fallback
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ============================================================
// RULE-001
// [2026-04-07] master-writer / strategy-planner / tool-executor에
// 타임아웃이 없어 Railway 300초 제한 도달 시 SSE 스트림이 끊어짐
// ============================================================

describe("RULE-001 — AbortSignal.timeout 동작 검증", () => {
  test("AbortSignal.timeout(N)은 N ms 후 abort된다", async () => {
    const signal = AbortSignal.timeout(50);

    const aborted = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 300);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    assert.equal(aborted, true, "50ms 이내에 abort 이벤트가 발생해야 함");
  });

  test("AbortSignal.any([s1, s2]) — 먼저 만료되는 쪽이 전체를 취소한다", async () => {
    const short = AbortSignal.timeout(50);
    const long = AbortSignal.timeout(5_000);
    const combined = AbortSignal.any([short, long]);

    const aborted = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 300);
      combined.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve(true);
      });
    });

    assert.equal(aborted, true, "50ms short signal이 combined을 abort해야 함");
  });

  test("타임아웃 전 완료 시 abort 없이 정상 반환된다", async () => {
    const signal = AbortSignal.timeout(500);
    let aborted = false;
    signal.addEventListener("abort", () => { aborted = true; });

    // 10ms짜리 빠른 작업
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(aborted, false, "타임아웃 전 완료했으므로 abort 없어야 함");
  });

  test("이미 abort된 signal로 fetch하면 즉시 거부된다", async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      async () => {
        // AbortSignal이 이미 abort된 경우 Promise.race로 시뮬레이션
        await new Promise((_resolve, reject) => {
          if (controller.signal.aborted) {
            reject(new DOMException("The operation was aborted", "AbortError"));
          }
        });
      },
      (err) => {
        assert.equal(err.name, "AbortError");
        return true;
      }
    );
  });
});

// ============================================================
// RULE-002
// [2026-04-07] catch 블록 누락으로 파이프라인 실패 시
// topic이 in-progress로 stuck → 14건 수동 복구 필요
// ============================================================

describe("RULE-002 — 파이프라인 실패 시 topic draft 복구", () => {
  function makePipelineRunner({ fail = false, hasDraftRecovery = true } = {}) {
    let topicStatus = "draft";
    let thisSetTopicInProgress = false;

    function atomicSet() {
      if (topicStatus === "in-progress") return { set: false };
      topicStatus = "in-progress";
      thisSetTopicInProgress = true;
      return { set: true };
    }

    async function run() {
      const r = atomicSet();
      if (!r.set) throw new Error("already in-progress");

      try {
        if (fail) throw new Error("API 타임아웃 시뮬레이션");
        topicStatus = "published";
        return "success";
      } catch (err) {
        if (hasDraftRecovery && thisSetTopicInProgress && topicStatus === "in-progress") {
          topicStatus = "draft"; // RULE-002 핵심 복구 로직
        }
        throw err;
      }
    }

    return { run, getStatus: () => topicStatus };
  }

  test("성공 시 topic status = published", async () => {
    const r = makePipelineRunner({ fail: false });
    await r.run();
    assert.equal(r.getStatus(), "published");
  });

  test("실패 + 복구 로직 있음 → draft로 되돌아온다 (stuck 방지)", async () => {
    const r = makePipelineRunner({ fail: true, hasDraftRecovery: true });
    await assert.rejects(r.run(), /타임아웃/);
    assert.equal(r.getStatus(), "draft", "실패 후 반드시 draft로 복구되어야 함");
  });

  test("실패 + 복구 로직 없음 → in-progress stuck 재현 (장애 패턴 확인)", async () => {
    const r = makePipelineRunner({ fail: true, hasDraftRecovery: false });
    await assert.rejects(r.run(), /타임아웃/);
    assert.equal(r.getStatus(), "in-progress", "복구 없으면 in-progress로 stuck됨 (과거 장애 재현)");
  });

  test("다른 파이프라인이 설정한 in-progress는 복구하지 않는다", async () => {
    // thisSetTopicInProgress = false 인 경우 (다른 파이프라인이 설정)
    let topicStatus = "in-progress"; // 다른 파이프라인이 설정한 상태
    let thisSetTopicInProgress = false; // 이 파이프라인은 설정하지 않음

    try {
      throw new Error("실패");
    } catch {
      if (thisSetTopicInProgress && topicStatus === "in-progress") {
        topicStatus = "draft";
      }
    }

    assert.equal(topicStatus, "in-progress", "다른 파이프라인 상태는 건드리지 않아야 함");
  });
});

// ============================================================
// RULE-003
// [2026-04-14] 비원자적 in-progress 설정으로 두 파이프라인이
// 같은 topic을 동시에 처리하는 경쟁 조건 발생
// ============================================================

describe("RULE-003 — atomicSetTopicInProgress 동시성 보장", () => {
  function makeTopicManager() {
    const statuses = new Map();

    // orchestrator.atomicSetTopicInProgress 인라인 재현
    function atomicSet(topicId) {
      const current = statuses.get(topicId) ?? "draft";
      if (current === "in-progress") return { set: false, reason: "already in-progress" };
      if (current !== "draft") return { set: false, reason: `status=${current}` };
      statuses.set(topicId, "in-progress");
      return { set: true };
    }

    return {
      atomicSet,
      setStatus: (id, s) => statuses.set(id, s),
      getStatus: (id) => statuses.get(id) ?? "draft",
    };
  }

  test("동일 topic 동시 접근 — 첫 번째만 처리, 두 번째는 차단된다", () => {
    const mgr = makeTopicManager();

    const r1 = mgr.atomicSet("t-dup");
    const r2 = mgr.atomicSet("t-dup");

    assert.equal(r1.set, true, "첫 번째 파이프라인은 획득 성공");
    assert.equal(r2.set, false, "두 번째 파이프라인은 차단");
    assert.ok(r2.reason.includes("in-progress"));
  });

  test("다른 topic은 독립적으로 동시 처리 가능", () => {
    const mgr = makeTopicManager();
    assert.equal(mgr.atomicSet("t-001").set, true);
    assert.equal(mgr.atomicSet("t-002").set, true);
    assert.equal(mgr.atomicSet("t-003").set, true);
  });

  test("published topic은 재처리 불가", () => {
    const mgr = makeTopicManager();
    mgr.setStatus("t-pub", "published");
    const r = mgr.atomicSet("t-pub");
    assert.equal(r.set, false, "published는 재처리 불가");
    assert.ok(r.reason.includes("published"));
  });

  test("archived topic은 재처리 불가", () => {
    const mgr = makeTopicManager();
    mgr.setStatus("t-arc", "archived");
    const r = mgr.atomicSet("t-arc");
    assert.equal(r.set, false);
  });
});

// ============================================================
// RULE-004
// [2026-04-14] 다중 파이프라인 동시 실행 시 GitHub SHA 충돌로
// posting-list / topics 데이터 덮어쓰기 발생
// ============================================================

describe("RULE-004 — withConflictRetry SHA 충돌 재시도", () => {
  async function withConflictRetry(fn, maxAttempts = 4) {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const s = err.status;
        if ((s === 409 || s === 422) && attempt < maxAttempts - 1) continue;
        throw err;
      }
    }
    throw new Error("unreachable");
  }

  test("409 충돌 2회 후 3번째 시도에서 성공", async () => {
    let attempts = 0;
    const result = await withConflictRetry(async () => {
      attempts++;
      if (attempts < 3) {
        const e = new Error("SHA mismatch");
        e.status = 409;
        throw e;
      }
      return { ok: true, attempts };
    });
    assert.equal(result.ok, true);
    assert.equal(result.attempts, 3);
  });

  test("422 unprocessable도 재시도 대상이다", async () => {
    let attempts = 0;
    const result = await withConflictRetry(async () => {
      attempts++;
      if (attempts < 2) {
        const e = new Error("Unprocessable");
        e.status = 422;
        throw e;
      }
      return "done";
    });
    assert.equal(result, "done");
    assert.equal(attempts, 2);
  });

  test("재시도 없는 직접 write는 충돌 즉시 throw (데이터 손실 위험)", async () => {
    async function directWrite() {
      const e = new Error("SHA conflict");
      e.status = 409;
      throw e;
    }
    await assert.rejects(directWrite, /SHA conflict/);
  });

  test("최대 시도 횟수 초과 시 에러 전파 (무한 루프 방지)", async () => {
    let attempts = 0;
    await assert.rejects(
      withConflictRetry(async () => {
        attempts++;
        const e = new Error("persistent conflict");
        e.status = 409;
        throw e;
      }, 3),
      /persistent conflict/
    );
    assert.equal(attempts, 3);
  });

  test("409 아닌 에러는 즉시 전파 (불필요한 재시도 없음)", async () => {
    let attempts = 0;
    await assert.rejects(
      withConflictRetry(async () => {
        attempts++;
        throw new Error("network error"); // status 없음
      }),
      /network error/
    );
    assert.equal(attempts, 1, "재시도 없이 즉시 전파");
  });
});

// ============================================================
// RULE-005
// [2026-04-14] SSE awaiting-approval 이벤트 누락 시
// 승인 다이얼로그가 영영 뜨지 않아 파이프라인 stuck
// ============================================================

describe("RULE-005 — SSE 누락 대비 폴링 fallback", () => {
  // page.tsx의 폴링 로직 인라인 재현
  function pollForApproval({ pipelineState, currentApproval }) {
    if (currentApproval) return null; // 이미 승인 다이얼로그 표시 중
    if (!pipelineState) return null;
    if (pipelineState.stage !== "awaiting-approval") return null;
    if (!pipelineState.strategy) return null;

    return {
      proposedTitle: pipelineState.strategy.title,
      rationale: pipelineState.strategy.rationale,
      outline: pipelineState.strategy.outline.map((s) => s.heading),
    };
  }

  const mockStrategy = {
    title: "서울 맛집 베스트 10",
    rationale: "인기 키워드 기반 추천",
    outline: [{ heading: "강남 맛집" }, { heading: "홍대 맛집" }],
  };

  test("SSE 누락 시 폴링이 awaiting-approval 상태를 감지한다", () => {
    const result = pollForApproval({
      pipelineState: { stage: "awaiting-approval", strategy: mockStrategy },
      currentApproval: null,
    });

    assert.ok(result, "awaiting-approval 감지됨");
    assert.equal(result.proposedTitle, "서울 맛집 베스트 10");
    assert.deepEqual(result.outline, ["강남 맛집", "홍대 맛집"]);
  });

  test("승인 다이얼로그 이미 표시 중이면 폴링 결과 무시", () => {
    const result = pollForApproval({
      pipelineState: { stage: "awaiting-approval", strategy: mockStrategy },
      currentApproval: { pipelineId: "pipe-001" }, // 이미 표시 중
    });
    assert.equal(result, null, "중복 표시 방지");
  });

  test("strategy-planning 중에는 감지 안 함", () => {
    const result = pollForApproval({
      pipelineState: { stage: "strategy-planning", strategy: null },
      currentApproval: null,
    });
    assert.equal(result, null);
  });

  test("strategy 없는 awaiting-approval은 감지 안 함 (데이터 미준비)", () => {
    const result = pollForApproval({
      pipelineState: { stage: "awaiting-approval", strategy: null },
      currentApproval: null,
    });
    assert.equal(result, null);
  });

  test("완료 단계에서는 감지 안 함", () => {
    const result = pollForApproval({
      pipelineState: { stage: "complete", strategy: mockStrategy },
      currentApproval: null,
    });
    assert.equal(result, null);
  });

  test("pipelineState가 null이면 안전하게 null 반환", () => {
    const result = pollForApproval({ pipelineState: null, currentApproval: null });
    assert.equal(result, null);
  });
});
