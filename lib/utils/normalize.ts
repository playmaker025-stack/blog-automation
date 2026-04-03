/**
 * normalize — 비교용 문자열 정규화
 * trim → 소문자 → 연속 공백/줄바꿈 제거 → 대시 통일 → 따옴표 제거 → 괄호 공백 정리
 */
export function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/[\r\n]+/g, " ")       // 줄바꿈 → 공백
    .replace(/\s+/g, " ")           // 연속 공백 제거
    .replace(/[–—]/g, "-")          // 긴 대시 통일
    .replace(/['"'"]/g, "")         // 따옴표 제거
    .replace(/\s*\(\s*/g, "(")      // 괄호 앞 공백 정리
    .replace(/\s*\)\s*/g, ")")      // 괄호 뒤 공백 정리
    .trim();
}

/**
 * normalizeUserId — userId 정규화 (trim + toLowerCase)
 */
export function normalizeUserId(userId: string): string {
  return userId.trim().toLowerCase();
}
