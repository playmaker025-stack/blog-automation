# /evaluate — 기존 포스팅 재평가

기존 포스팅을 harness-evaluator로 재평가하고 eval 점수를 업데이트한다.

## 사용법

```
/evaluate postId=<포스팅ID> [caseId=<케이스ID>]
```

## 실행 흐름

1. postId로 포스팅 본문 로드
2. caseId가 있으면 해당 eval 케이스 기준으로 평가
3. caseId가 없으면 기본 평가 기준 사용
4. EvalRun 결과 저장 (evals/runs/{runId}.json)
5. posting-list의 evalScore 업데이트

## 예시

```
/evaluate postId=post-abc123
/evaluate postId=post-abc123 caseId=case-001
```
