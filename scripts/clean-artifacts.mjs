/**
 * 가비지 컬렉션 스크립트
 * - 7일 이상 된 파이프라인 아티팩트 삭제
 * - 고아 상태(orphan) 파이프라인 데이터 정리
 *
 * 실행: node scripts/clean-artifacts.mjs
 * 옵션: --dry-run (실제 삭제 없이 대상만 출력)
 */

import { readdir, stat, rm } from 'fs/promises'
import { join } from 'path'

const ARTIFACTS_DIR = join(process.cwd(), 'data', 'pipeline-ledger', 'artifacts')
const MAX_AGE_DAYS = 7
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 60 * 60 * 1000

const isDryRun = process.argv.includes('--dry-run')

async function directoryExists(dir) {
  try {
    await stat(dir)
    return true
  } catch {
    return false
  }
}

async function cleanOldArtifacts() {
  if (!(await directoryExists(ARTIFACTS_DIR))) {
    console.log('아티팩트 디렉토리 없음 — 건너뜀')
    return
  }

  const pipelineDirs = await readdir(ARTIFACTS_DIR)
  const now = Date.now()
  let removed = 0
  let kept = 0

  for (const pipelineId of pipelineDirs) {
    const pipelinePath = join(ARTIFACTS_DIR, pipelineId)
    const info = await stat(pipelinePath)

    if (!info.isDirectory()) continue

    const ageMs = now - info.mtimeMs
    const ageDays = (ageMs / (24 * 60 * 60 * 1000)).toFixed(1)

    if (ageMs > MAX_AGE_MS) {
      if (isDryRun) {
        console.log(`[dry-run] 삭제 대상: ${pipelineId} (${ageDays}일 경과)`)
      } else {
        await rm(pipelinePath, { recursive: true, force: true })
        console.log(`삭제: ${pipelineId} (${ageDays}일 경과)`)
      }
      removed++
    } else {
      kept++
    }
  }

  const mode = isDryRun ? '[dry-run] ' : ''
  console.log(`\n${mode}완료 — 삭제: ${removed}개, 유지: ${kept}개`)
}

cleanOldArtifacts().catch((err) => {
  console.error('정리 실패:', err)
  process.exit(1)
})
