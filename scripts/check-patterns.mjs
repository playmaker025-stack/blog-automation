/**
 * 패턴 검사 — CLAUDE.md "알려진 실패 패턴" 자동 집행
 *
 * 과거 실제 장애에서 도출된 규칙을 코드에서 직접 검사한다.
 * verify.mjs의 [patterns] 단계에서 실행된다.
 *
 * RULE-001  client.messages.create/stream 호출에 AbortSignal 필수
 * RULE-002  orchestrator.ts catch 블록에 topic draft 복구 로직 필수
 * RULE-003  "in-progress" 직접 할당은 atomicSetTopicInProgress 전용
 * RULE-004  posting-list/topics writeJsonFile은 withConflictRetry 안에서만 허용
 */

import { readFileSync, readdirSync } from 'fs'
import { join, relative } from 'path'

const ROOT = process.cwd()
const AGENTS_DIR = join(ROOT, 'lib', 'agents')

const violations = []

function fail(rule, filePath, lineNo, message) {
  violations.push({
    rule,
    loc: `${relative(ROOT, filePath).replace(/\\/g, '/')}:${lineNo}`,
    message,
  })
}

function lines(filePath) {
  return readFileSync(filePath, 'utf-8').split('\n')
}

function content(filePath) {
  return readFileSync(filePath, 'utf-8')
}

function agentFiles() {
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(AGENTS_DIR, f))
}

// ─────────────────────────────────────────────────────────────
// RULE-001
// client.messages.create / client.messages.stream 호출이 있는 모든 파일에서
// 해당 호출 이후 60줄 이내에 AbortSignal 또는 signal: 이 반드시 있어야 한다.
//
// 근거: [2026-04-07] 타임아웃 없는 API 호출로 Railway 300초 제한 도달 시
//       SSE 스트림이 끊어지고 topic이 in-progress로 stuck됨.
// ─────────────────────────────────────────────────────────────
for (const file of agentFiles()) {
  const ls = lines(file)
  for (let i = 0; i < ls.length; i++) {
    const line = ls[i]
    if (
      line.includes('client.messages.create') ||
      line.includes('client.messages.stream')
    ) {
      const window = ls.slice(i, i + 60).join('\n')
      if (!window.includes('AbortSignal') && !window.includes('signal:')) {
        fail(
          'RULE-001',
          file,
          i + 1,
          `client.messages API 호출에 AbortSignal.timeout 없음 — ` +
            `Railway 300초 제한 도달 시 무한 대기 발생`
        )
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// RULE-002
// orchestrator.ts 메인 catch 블록에 다음 3가지가 모두 있어야 한다:
//   1. thisSetTopicInProgress 플래그 확인
//   2. updateTopicStatus(..., "draft") 호출
//   3. 복구 실패 처리 catch
//
// 근거: [2026-04-07] catch 블록 누락으로 실패 시 topic이 in-progress로
//       stuck되어 14건 수동 복구 필요.
// ─────────────────────────────────────────────────────────────
const orchFile = join(AGENTS_DIR, 'orchestrator.ts')
const orchContent = content(orchFile)

const hasThisSetFlag = orchContent.includes('thisSetTopicInProgress')
const hasDraftRecovery = /updateTopicStatus\s*\([^)]*,\s*"draft"\)/.test(orchContent)
const hasRecoveryCatch = orchContent.includes('topic recovery failed')

if (!hasThisSetFlag) {
  fail('RULE-002', orchFile, 0, 'thisSetTopicInProgress 플래그가 없음 — 동시 복구 충돌 방지 로직 누락')
}
if (!hasDraftRecovery) {
  fail('RULE-002', orchFile, 0, 'updateTopicStatus(..., "draft") 호출 없음 — in-progress stuck 복구 로직 누락')
}
if (!hasRecoveryCatch) {
  fail('RULE-002', orchFile, 0, 'topic recovery failed 로그 없음 — 복구 실패 무시 처리 누락')
}

// ─────────────────────────────────────────────────────────────
// RULE-003
// status: "in-progress" 직접 할당은 orchestrator.ts의
// atomicSetTopicInProgress 함수 내부에서만 허용된다.
// 다른 모든 파일·위치에서 이 패턴이 발견되면 위반.
//
// 근거: [2026-04-14] 비원자적 in-progress 설정으로 두 파이프라인이
//       같은 topic을 동시 처리하는 경쟁 조건 발생.
// ─────────────────────────────────────────────────────────────
for (const file of agentFiles()) {
  const ls = lines(file)
  const isOrchestrator = file.endsWith('orchestrator.ts')

  for (let i = 0; i < ls.length; i++) {
    const line = ls[i]
    // 주석 제외, status 할당 패턴 탐지
    if (/status:\s*["']in-progress["']/.test(line) && !line.trimStart().startsWith('//')) {
      if (!isOrchestrator) {
        fail('RULE-003', file, i + 1, `"in-progress" 직접 할당 — atomicSetTopicInProgress(orchestrator.ts)만 허용`)
      } else {
        // orchestrator 내부라도 atomicSetTopicInProgress 함수 바깥이면 위반
        const surroundingBack = ls.slice(Math.max(0, i - 40), i + 1).join('\n')
        if (
          !surroundingBack.includes('atomicSetTopicInProgress') &&
          !surroundingBack.includes('statusAtReject')
        ) {
          fail(
            'RULE-003',
            file,
            i + 1,
            `orchestrator.ts 내 "in-progress" 직접 할당 — atomicSetTopicInProgress 함수 외부`
          )
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// RULE-004
// orchestrator.ts에서 writeJsonFile 직접 호출은 반드시
// withConflictRetry 블록 안에 있어야 한다.
//
// 근거: [2026-04-14] 다중 파이프라인 동시 실행 시 SHA 충돌로
//       posting-list/topics 데이터 손실 발생.
// ─────────────────────────────────────────────────────────────
{
  const ls = lines(orchFile)
  for (let i = 0; i < ls.length; i++) {
    if (ls[i].includes('writeJsonFile(')) {
      // 앞 80줄 안에 withConflictRetry 또는 atomicSetTopicInProgress 가 있어야 함
      // (실제 콜백이 35~40줄에 달하는 경우가 있어 넉넉하게 설정)
      const lookback = ls.slice(Math.max(0, i - 80), i + 1).join('\n')
      if (
        !lookback.includes('withConflictRetry') &&
        !lookback.includes('atomicSetTopicInProgress')
      ) {
        fail(
          'RULE-004',
          orchFile,
          i + 1,
          `writeJsonFile 호출이 withConflictRetry 없이 직접 실행됨 — SHA 충돌 재시도 불가`
        )
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 결과 출력
// ─────────────────────────────────────────────────────────────
if (violations.length === 0) {
  process.exit(0)
}

for (const v of violations) {
  console.error(`  [${v.rule}] ${v.loc} — ${v.message}`)
}
process.exit(1)
