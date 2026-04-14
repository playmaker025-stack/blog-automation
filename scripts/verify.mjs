/**
 * 자동 교정 루프용 검증 스크립트
 *
 * 실행: node scripts/verify.mjs
 * 옵션:
 *   --skip-build   빌드 건너뜀 (빠른 검증)
 *   --skip-test    harness 테스트 건너뜀
 *
 * 종료 코드:
 *   0 = 모든 검증 통과
 *   1 = 하나 이상 실패 (실패 로그: data/verify-failures/YYYY-MM-DD_HH-mm-ss.json)
 */

import { execSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

const FAILURES_DIR = join(process.cwd(), 'data', 'verify-failures')

const skipBuild = process.argv.includes('--skip-build')
const skipTest = process.argv.includes('--skip-test')

const steps = [
  {
    name: 'typecheck',
    cmd: 'npx tsc --noEmit --skipLibCheck',
    description: 'TypeScript 타입 검사',
  },
  {
    name: 'lint',
    cmd: 'npx eslint . --max-warnings=0 --quiet',
    description: 'ESLint 코드 품질 검사',
    skip: false,
  },
  {
    name: 'patterns',
    cmd: 'node scripts/check-patterns.mjs',
    description: '알려진 실패 패턴 재발 방지 검사 (RULE-001~004)',
  },
  ...(!skipBuild
    ? [
        {
          name: 'build',
          cmd: 'npx next build',
          description: 'Next.js 프로덕션 빌드',
        },
      ]
    : []),
  ...(!skipTest
    ? [
        {
          name: 'harness',
          cmd: 'node --test tests/harness/*.test.mjs',
          description: 'Harness 통합 테스트 (회귀 포함)',
        },
      ]
    : []),
]

function run(cmd) {
  return execSync(cmd, {
    encoding: 'utf-8',
    stdio: 'pipe',
    cwd: process.cwd(),
  })
}

function saveFailureLog(failures) {
  mkdirSync(FAILURES_DIR, { recursive: true })
  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19)
  const logPath = join(FAILURES_DIR, `${timestamp}.json`)
  writeFileSync(
    logPath,
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        failures,
      },
      null,
      2,
    ),
  )
  return logPath
}

const results = []
let hasFailure = false

console.log('\n=== 검증 시작 ===\n')

for (const step of steps) {
  process.stdout.write(`[${step.name}] ${step.description} ... `)

  try {
    run(step.cmd)
    console.log('✅ 통과')
    results.push({ step: step.name, status: 'pass' })
  } catch (err) {
    const stderr = err.stderr || ''
    const stdout = err.stdout || ''
    const output = (stdout + '\n' + stderr).trim()

    console.log('❌ 실패')
    console.log('\n--- 오류 내용 ---')
    console.log(output)
    console.log('---\n')

    results.push({
      step: step.name,
      status: 'fail',
      error: output,
      exitCode: err.status,
    })
    hasFailure = true
  }
}

console.log('\n=== 검증 결과 ===')
for (const r of results) {
  const icon = r.status === 'pass' ? '✅' : '❌'
  console.log(`${icon} ${r.step}`)
}

if (hasFailure) {
  const failures = results.filter((r) => r.status === 'fail')
  const logPath = saveFailureLog(failures)
  console.log(`\n실패 로그 저장: ${logPath}`)
  console.log('\n[자동 교정 루프] 위 오류를 수정한 후 다시 실행하세요.')
  process.exit(1)
} else {
  console.log('\n모든 검증 통과 ✅ — 배포 준비 완료')
  process.exit(0)
}
