# /verify — 자동 교정 루프 (코드 검증 + 앱 E2E 검증 + 2단계 재검증)

코드 수정 후 이 명령어를 실행하면 Claude가 아래 전체 검증을 통과할 때까지 반복한다.  
모든 검증이 통과해도, stop hook이 코드 검증을 한 번 더 실행해 완벽한지 확인 후 루프를 종료한다.

## 실행 방법

```bash
~/.claude/ralph-setup.sh \
  "아래 전체 검증 절차를 실행해서 모든 ✅ 가 나올 때까지 오류를 수정하라. 모든 통과 시 <promise>done</promise>을 출력하라." \
  --completion-promise "done" \
  --double-check-cmd "node scripts/verify.mjs --skip-build --skip-test"
```

## 검증 절차 (순서대로 전부 통과해야 함)

### 1단계: 코드 검증

```bash
node scripts/verify.mjs --skip-build --skip-test
```

전체 검증 (빌드 + harness 포함):
```bash
node scripts/verify.mjs
```

| 실패 단계 | 수정 방법 |
|-----------|-----------|
| `typecheck` | 오류 메시지의 파일:줄번호 확인 → 타입 오류 수정 |
| `lint` | `npx eslint --fix` 자동 수정 후 잔여 오류 수동 처리 |
| `build` | Next.js 빌드 오류 → 해당 파일 수정 |
| `harness` | 실패한 테스트 확인 → 구현 로직 또는 테스트 수정 |
| `patterns` | check-patterns.mjs 출력 확인 → 규칙 위반 수정 |

### 2단계: 앱 E2E 검증 (Playwright MCP)

코드 검증이 전부 ✅ 통과한 후, **Playwright MCP를 사용해** 실제 앱을 브라우저로 검증한다.  
대상 URL: `https://blog-automation-production-c462.up.railway.app`

검증 항목:

| 페이지 | 확인 항목 |
|--------|-----------|
| `/topics` | 페이지 로드 성공, 글목록 표시, 텍스트 붙여넣기 탭 파싱 작동 |
| `/posts` | 페이지 로드 성공, 발행 인덱스 표시 |
| `/pipeline` | 페이지 로드 성공, 사용자 ID 입력 → 드롭다운 필터 작동, 파이프라인 상태 패널 표시 |

E2E 검증 실패 시 → 해당 UI/API 코드를 수정하고 1단계부터 다시 실행.

### 3단계: 완료 선언

1단계 + 2단계가 **전부** ✅ 통과 시에만 `<promise>done</promise>` 출력.

## 재검증 시스템 흐름

```
1단계: node scripts/verify.mjs (코드 검증)
  ├─ ❌ 실패 → 수정 → 재실행
  └─ ✅ 통과
          ↓
2단계: Playwright MCP로 앱 E2E 검증
  ├─ ❌ 실패 → UI/API 코드 수정 → 1단계부터 재실행
  └─ ✅ 통과
          ↓
<promise>done</promise> 출력
          ↓
stop hook: double-check 자동 실행
node scripts/verify.mjs --skip-build --skip-test
  ├─ ❌ 실패 → 오류 피드백 → Claude 재수정 (루프)
  └─ ✅ 통과 → 루프 완전 종료
```

## 규칙

- 코드 검증과 E2E 검증 **둘 다** 통과해야 `<promise>done</promise>` 출력
- 실패 로그는 `data/verify-failures/` 에 자동 저장됨 — 삭제 금지
