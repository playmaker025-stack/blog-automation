# Skills — 스킬 개요

스킬은 에이전트가 사용하는 도구 함수다.
모든 스킬은 `lib/skills/` 에 구현되어 있으며,
Anthropic SDK tool-use 형식으로 에이전트에 등록된다.

## 스킬 목록

| 스킬 | 파일 | LLM 호출 | 설명 |
|------|------|----------|------|
| `source-resolver` | `source-resolver.ts` | 없음 | 참조 URL 유효성 검증 + 제목/요약 추출 |
| `topic-feasibility-judge` | `topic-feasibility-judge.ts` | 없음 | 토픽 실현 가능성 휴리스틱 판단 |
| `user-profile-loader` | `user-profile-loader.ts` | 없음 | 사용자 프로필 + 금지 표현 GitHub에서 로드 |
| `user-corpus-retriever` | `user-corpus-retriever.ts` | 없음 | 사용자 예시 글 코퍼스 GitHub에서 로드 |
| `expansion-planner` | `expansion-planner.ts` | 없음 | 아웃라인 → 섹션별 상세 작성 방향 계획 |
| `review-record-audit` | `review-record-audit.ts` | 없음 | 과거 포스팅 패턴 분석 |

## 입출력 타입

모든 스킬의 입출력 타입은 `lib/types/skill.ts` 에 정의되어 있다.

## 에이전트별 스킬 사용

```
strategy-planner
  ├── user-profile-loader
  ├── user-corpus-retriever
  ├── topic-feasibility-judge
  ├── source-resolver
  └── review-record-audit

master-writer
  ├── user-corpus-retriever
  ├── expansion-planner
  └── source-resolver

harness-evaluator
  ├── user-corpus-retriever
  └── review-record-audit
```
