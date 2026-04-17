# Blog Automation — 네이버 블로그 그룹화 작성 시스템

---

## 🚨 최우선 행동 강령 — 세션 시작 시 가장 먼저 읽고 반드시 준수

> **이 섹션은 Claude의 모든 기본 동작보다 우선한다. 예외 없이 적용된다.**

### 1. 모든 응답·작업은 한국어로

- 질문, 설명, 코드 주석, 커밋 메시지, 오류 분석 — **전부 한국어**
- 영어 응답 금지. 코드 내 변수명·API명은 영어 유지, 나머지는 모두 한국어

### 2. 확인·승인 요청 절대 금지

Claude는 아래 **단 2가지 예외**를 제외하고 **모든 작업을 즉시 실행한다.**

| 예외 | 설명 |
|------|------|
| 보안 이슈 | 인증 정보 노출, 권한 변경, 취약점 코드 수정 |
| 외부 API 직접 호출 | Anthropic, GitHub, Naver 등 실제 외부 요청 |

**다음은 절대 물어보지 않는다 (즉시 실행):**
- git push / commit / reset / branch 삭제
- 파일·디렉토리 삭제
- 패키지 설치·제거
- 코드 수정·리팩토링
- 설정 파일 변경
- 빌드·테스트 실행
- 클론·복사·이동
- 위 목록에 없는 모든 일반 작업

**금지 문구 — 절대 사용하지 말 것:**
`~할까요?` / `~해도 될까요?` / `~진행할까요?` / `확인해 주세요` / `괜찮으신가요?`

### 3. 사용자 호칭

사용자는 Claude(나)를 **"cc"** 라고 부른다.

---

## 프로젝트 개요

다중 사용자 기반 네이버 블로그 포스팅 자동화 웹앱.
사용자별 코퍼스(예시 글)를 기반으로 AI가 글쓰기 스타일을 학습하고,
토픽 전략 수립 → 초안 생성 → 품질 평가 → 발행 흐름을 자동화한다.

## ⚠️ 절대 규칙 — 확인 금지 (OVERRIDE ALL DEFAULTS)

> **이 규칙은 Claude의 기본 동작을 완전히 대체한다. 어떤 상황에서도 예외 없이 적용된다.**

Claude는 아래 두 가지를 제외한 **모든 작업을 확인 없이 즉시 실행한다.**

**확인이 허용되는 예외 2가지 (이것만):**
1. **보안 이슈** — 인증 정보 노출, 권한 변경, 취약점 관련 코드 수정 등
2. **외부 API 직접 호출** — Anthropic, GitHub, Naver 등 외부 서비스에 실제 요청을 보내는 작업

**절대 확인하지 말아야 할 것들 (예시):**
- git push, git commit, git reset, git branch 삭제
- 파일 삭제, 디렉토리 삭제
- 패키지 설치/제거
- 리팩토링, 코드 수정
- 설정 파일 변경
- 테스트 실행
- 빌드 실행

위 목록에 없는 작업도 마찬가지다. **보안 이슈 또는 외부 API 호출이 아닌 이상, 절대 확인하지 않고 즉시 실행한다.**

"~할까요?", "~해도 될까요?", "~진행할까요?", "확인해 주세요" 같은 문구는 사용 금지다.

---

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
4. **테스트 실패 시 수정** — 테스트가 실패하면 구현 로직 또는 테스트 자체를 수정한다.
5. **완료 선언 직전 재검증 필수** — "완료", "배포 완료", "done" 등 작업 종료를 선언하기 직전에 반드시 `/verify`를 한 번 더 실행한다. 모든 ✅ 확인 후에만 완료를 선언한다. push 이후라도 예외 없이 적용.

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

### [2026-04-07] 파이프라인 초안쓰기 단계에서 무한 대기 (stuck)

**증상**: 전략 수립 → 승인 → 초안쓰기 단계에서 Railway 서버가 응답 없이 멈춤. topic 상태가 `in-progress`로 남고 빈 draft post(`wordCount:0`)가 생성됨.

**원인 분석**:
1. `master-writer.ts`의 `client.messages.create` 호출에 타임아웃이 없어 Railway 300초 제한 도달 시 SSE 스트림이 끊어짐
2. `tool-executor.ts`의 `runToolUseLoop`도 동일하게 타임아웃 없음
3. 파이프라인 실패 시 catch 블록에서 topic을 `draft`로 복구하지 않아 `in-progress` stuck 발생

**수정 사항**:
- `master-writer.ts`: `AbortSignal.timeout(60_000)` 각 API 호출에 적용
- `tool-executor.ts`: `AbortSignal.timeout(90_000)` 각 API 호출에 적용
- `strategy-planner.ts`: `AbortSignal.timeout(60_000)` 적용
- `orchestrator.ts` catch 블록: 실패 시 topic status를 `in-progress` → `draft`로 자동 복구

**재발 방지 규칙**:
- 모든 `client.messages.create` 호출에는 반드시 `AbortSignal.timeout(N)` 옵션을 추가할 것
- 파이프라인 실패 시 topic/post 상태를 원상복구하는 로직을 catch 블록에 반드시 포함할 것
- 수동 복구 절차: `PATCH /api/github/topics` → `{topicId, status:"draft"}`, `DELETE /api/github/posts?postId=XXX`

### [2026-04-07] 교차체크 불일치 — 임포트된 posts의 topicId 없음

**증상**: 발행 인덱스(posts)에는 글이 있는데 글목록(topics)에서는 아직 미작성(draft)으로 표시됨.

**원인**: 기존에 임포트된 posts는 `topicId: ""`이므로 `topicId` 기반 매칭 불가. `resolveRemainingTopics`는 3-key 매칭(userId + blogCode + title normalize) 방식 사용. 제목이 정확히 일치하지 않으면 매칭 실패.

**수정 [2026-04-17]**: `lib/skills/remaining-topic-resolver.ts` — 2-pass 매칭으로 개선.
1. exact 3-key (기존)
2. 동일 uid+blog 파티션 내 **token-prefix fallback** — topic 토큰열이 post 토큰열의 단어 경계 prefix이면 매칭. 구분자(`|`, `–`, `—`, `-`, `,`, `:`, `(`, `)` 등)는 공백 처리.

**false positive 방지**:
- 한 post는 최대 1개 topic과만 매칭 (postId 소비 추적)
- 동일 uid+blog 파티션 내에서만 비교
- topic 토큰 <3개면 prefix 매칭 비활성

**개선 효과**: 32개 중 `matched 7 → 21` (미매칭 25 → 11). 남은 11개는 실제 미작성 항목.

**회귀 테스트**: `tests/harness/regression.test.mjs` RULE-006 (7 케이스).

### [2026-04-17] strategy-planner "AI 분석 중 4/6"에서 멈춤 (동시 접속 시 오탐)

**증상**: 두 사용자가 동시에 파이프라인 시작 시, strategy-planner가 "AI 분석 중... (4/6)" 단계에서 멈추고 클라이언트 버튼이 "글쓰기 진행중" → "글쓰기 시작"으로 되돌아감. 서버는 에러 처리로 끝나지만 무엇이 원인인지 UI에 반영 안 됨.

**원인 분석**:
1. `tool-executor.ts`의 `CALL_TIMEOUT_MS = 90s` 타이머가 **세마포어 획득 전에** 시작 — 큐 대기 시간이 타임아웃에 카운트되어 동시 접속 시 부당 오탐
2. non-streaming 모드라 첫 토큰까지의 지연과 이후 스톨을 분리 감지 불가
3. `pipeline-runner`의 `start`/`runWritePhase` catch 블록이 generic 문구만 표시 — 사용자는 무슨 일인지 모름

**수정 [2026-04-17]**:
- `lib/anthropic/tool-executor.ts`: master-writer와 동일 패턴 — `anthropicSemaphore.run(async () => { stallTimer = setTimeout(...); })`로 **세마포어 획득 후** 타이머 시작. INITIAL 150s / STALL 90s / hardDeadline 160s. `client.messages.stream()` 스트리밍 모드로 전환해 각 이벤트마다 stallTimer reset.
- `lib/pipeline-runner.ts`: catch 블록이 `err.message`를 pipelineError에 포함. SSE가 result/approval 없이 끝난 경우에도 구체적 메시지 표시.

**재발 방지 규칙**:
- Anthropic API 호출 타이머는 **반드시 세마포어 획득 후**에 시작할 것 (`anthropicSemaphore.run(async () => { ... 타이머 ... })`)
- 큐 대기 시간을 타임아웃에 포함하는 패턴 금지 — 동시 접속 오탐의 근본 원인
- streaming 모드 사용 — 첫 토큰 전/후 스톨을 분리 감지
- 클라이언트 catch 블록은 `err.message`를 사용자 메시지에 포함할 것

**회귀 테스트**: `tests/harness/regression.test.mjs` RULE-007 (4 케이스).

## 개발 스택

- **Framework**: Next.js 15 (App Router, TypeScript)
- **Styling**: Tailwind CSS
- **AI**: Anthropic SDK (`@anthropic-ai/sdk`)
- **GitHub**: Octokit REST (`@octokit/rest`)
- **상태관리**: Zustand
- **데이터 캐싱**: SWR
