# 파이프라인 — 전체 실행 흐름

## 표준 파이프라인

```
사용자 입력 (topicId, userId)
  ↓
[1] topic-feasibility-judge (스킬)
    - 금지 표현 검사
    - 타깃 독자 적합성 확인
    - verdict: feasible / uncertain / blocked
  ↓ (blocked이면 중단, uncertain이면 경고 후 계속)
[2] strategy-planner (에이전트)
    도구: user-profile-loader, user-corpus-retriever,
          source-resolver, review-record-audit
    출력: StrategyPlan { outline, keyPoints, tone, keywords }
  ↓
[3] 제목/방향 변경 감지
    - 원본 topicId 제목과 StrategyPlan.title 비교
    - 실질적 변경이면 → 사용자 승인 요청 (awaiting-approval)
    - 승인 후 posting-list 업데이트 → data/index/topics.json 반영
  ↓
[4] master-writer (에이전트) — 유일한 발행 주체
    도구: user-corpus-retriever, expansion-planner, source-resolver
    출력: 마크다운 본문 (SSE 스트리밍)
    저장: data/posting-list/posts/{postId}/content.md
  ↓
[5] harness-evaluator (에이전트)
    도구: user-corpus-retriever, review-record-audit
    출력: EvalRun { scores, aggregateScore, reasoning }
    저장: evals/runs/{runId}.json
  ↓
[6] 완료 교차확인
    - posting-list: status = "ready" + evalScore 기록
    - data/index/topics.json: status = "in-progress" → 그대로 유지
    - 발행 확인 후: posting-list status = "published"
                   index status = "published"
```

## 승인 흐름 (제목/방향 변경 시)

```
변경 감지
  ↓
PendingApproval 객체 생성
posting-list에 pendingApproval 기록 (status: "awaiting-approval")
  ↓
사용자 승인 (웹 UI)
  ↓
승인 → posting-list 업데이트 (status: "draft", pendingApproval: null)
      → data/index/topics.json 반영
거절 → 원본 제목/방향으로 복원, 파이프라인 재시작
```

## 완료 판정 기준

두 조건을 모두 만족해야 "완료":

1. `data/posting-list/index.json` 에서 해당 postId의 `status === "published"`
2. `data/index/topics.json` 에서 해당 topicId의 `status === "published"`

둘 중 하나라도 미반영이면 완료 처리하지 않는다.
