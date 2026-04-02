# Harness — 평가 하네스 개요

## 목적

Master Writer가 생성한 블로그 본문의 품질을 일관된 기준으로 평가하고,
시계열 추적을 통해 프롬프트/전략 변경의 영향을 측정한다.

## 구성 요소

```
harness-evaluator (에이전트)
└── 스킬
    ├── user-corpus-retriever   # 사용자 글쓰기 스타일 참조
    └── review-record-audit     # 과거 포스팅 패턴 참조
```

## 평가 차원

| 차원 | 설명 | 가중치 (기본) |
|------|------|--------------|
| `originality` | 표절 없음, 독창적 관점 | 0.25 |
| `style_match` | 코퍼스 글쓰기 스타일 일치도 | 0.30 |
| `structure` | 논리적 흐름, 섹션 구성 | 0.20 |
| `engagement` | 독자 관심 유도, 가독성 | 0.15 |
| `forbidden_check` | 금지 표현 미포함 | 0.10 |

가중치 합계 = 1.0. eval case별로 커스터마이징 가능.

## 데이터 흐름

```
harness-evaluator.evaluate(postId, caseId?)
  ↓
evals/cases/index.json     ← 케이스 정의 로드
evals/baselines/results.json  ← 기준선 비교
  ↓
EvalRun 생성
evals/runs/{runId}.json    ← 결과 저장
posting-list 업데이트      ← evalScore 반영
```

## eval case 추가 방법

`evals/cases/index.json`에 새 케이스를 추가한다:

```json
{
  "caseId": "case-001",
  "name": "여행 카테고리 기준",
  "description": "여행 카테고리 포스팅 품질 평가",
  "inputTopicId": "topic-xxx",
  "goldenCriteria": [
    {
      "dimension": "style_match",
      "weight": 0.40,
      "rubric": "코퍼스 예시와 동일한 구어체 톤, 개인 경험 서술 방식 유지"
    }
  ],
  "createdAt": "2026-03-27T00:00:00.000Z"
}
```

## 베이스라인 관리

새 베이스라인을 설정하려면 `evals/baselines/results.json`에 결과를 추가한다.
베이스라인은 향후 실행 결과와 비교하여 회귀(regression)를 탐지하는 데 사용된다.
