# Blog Automation — 네이버 블로그 그룹화 작성 시스템

## 프로젝트 개요

다중 사용자 기반 네이버 블로그 포스팅 자동화 웹앱.
사용자별 코퍼스(예시 글)를 기반으로 AI가 글쓰기 스타일을 학습하고,
토픽 전략 수립 → 초안 생성 → 품질 평가 → 발행 흐름을 자동화한다.

## 핵심 원칙

1. **발행용 본문은 Master Writer 에이전트만 작성한다.**
   - 다른 에이전트 또는 직접 프롬프트로 생성된 본문은 발행 불가.

2. **완료 여부는 posting-list + index 교차확인으로 결정한다.**
   - posting-list에 `status: published`이고 index에 해당 topicId가 존재해야 완료.
   - 둘 중 하나라도 미반영이면 완료 처리하지 않는다.

3. **제목/방향이 실질적으로 바뀌면 사용자 승인 후 posting-list 수정, 그 다음 index 반영.**
   - 순서: 사용자 승인 → posting-list 업데이트 → index 업데이트
   - 역순 처리 금지.

4. **사용자 모델화는 GitHub 저장소의 corpus 기반 retrieval로 진행.**
   - 사용자별 corpus는 `user-modeling/users/{userId}/corpus/` 에 저장.
   - 스타일 모델링 시 항상 corpus retrieval 스킬을 먼저 호출.

## 에이전트 구조

```
orchestrator
├── strategy-planner    (토픽 분석 + 포스팅 전략 수립)
├── master-writer       (본문 생성 — 유일한 발행 주체)
└── harness-evaluator   (품질 평가 + eval 점수 산출)
```

## 스킬 목록

| 스킬 | 역할 |
|------|------|
| source-resolver | 참조 URL 유효성 검증 + 요약 |
| topic-feasibility-judge | 토픽 실현 가능성 판단 |
| user-profile-loader | 사용자 프로필 로드 |
| user-corpus-retriever | 사용자 예시 글 코퍼스 로드 |
| expansion-planner | 아웃라인 확장 계획 수립 |
| review-record-audit | 과거 포스팅 패턴 분석 |

## 데이터 구조 (GitHub 리포)

```
user-modeling/
└── users/{userId}/
    ├── profile.json            # 사용자 프로필
    ├── forbidden-expressions.json  # 금지 표현 목록
    └── corpus/
        ├── index.json          # 코퍼스 인덱스
        └── samples/{sampleId}.md   # 예시 글 본문

data/
├── posting-list/
│   └── index.json              # 포스팅 목록 (완료 여부 포함)
└── index/
    └── topics.json             # 토픽 인덱스

evals/
├── cases/index.json            # 평가 케이스
├── baselines/results.json      # 기준선 결과
└── runs/                       # 실제 평가 실행 결과
```

## 환경 변수

`.env.local` 파일 필요 (`.env.local.example` 참조):
- `ANTHROPIC_API_KEY` — Claude API 키
- `GITHUB_TOKEN` — GitHub Personal Access Token (repo scope)
- `GITHUB_DATA_REPO` — 데이터 리포 (예: `yourname/blog-data`)
- `GITHUB_DATA_REPO_BRANCH` — 브랜치 (기본값: `main`)

## dotfile 설정

이 프로젝트는 `.claude/agents/`, `.claude/commands/`, `.mcp.json`을 사용한다.
현재 N: 드라이브(Removable NTFS)에서는 dotfile 생성이 제한된다.
`_dotfiles/` 디렉토리에 템플릿이 있으며, 프로젝트를 C: 등으로 이동 후
`_dotfiles/setup.ps1` 스크립트를 실행하면 dotfile이 자동 생성된다.

## 코딩 자동 교정 루프 (필수)

코드를 작성하거나 수정한 후에는 반드시 아래 절차를 따른다.

### 규칙

1. **코드 수정 후 즉시 `/verify` 실행** — 수동 판단으로 완료 선언 금지
2. **실패 시 완료 선언 금지** — 모든 ✅ 가 나올 때까지 수정 반복
3. **실패 로그 보존** — `data/verify-failures/` 삭제 금지, 반복 실패 패턴은 "알려진 실패 패턴" 섹션에 기록
4. **테스트 수정 금지** — 테스트가 실패해도 구현 로직을 수정한다. 테스트 자체가 잘못됐다고 판단되면 사용자에게 확인 후 수정

### 검증 명령어

```bash
node scripts/verify.mjs            # 전체 검증 (typecheck + lint + build + harness)
node scripts/verify.mjs --skip-build --skip-test  # 빠른 검증 (typecheck + lint만)
```

### 자동 강제 시스템

| 시점 | 검사 항목 |
|------|-----------|
| `git commit` | ESLint + TypeScript (lint-staged) |
| `git push` | typecheck + lint + harness 테스트 |
| GitHub PR | CI 전체 (typecheck + lint + harness) |

## 알려진 실패 패턴

<!-- AI가 저질렀던 실수 목록 — 재발 방지용. 발견 시 한 줄씩 추가 -->

- (아직 기록된 실패 패턴 없음)

## 개발 스택

- **Framework**: Next.js 15 (App Router, TypeScript)
- **Styling**: Tailwind CSS
- **AI**: Anthropic SDK (`@anthropic-ai/sdk`)
- **GitHub**: Octokit REST (`@octokit/rest`)
- **상태관리**: Zustand
- **데이터 캐싱**: SWR
