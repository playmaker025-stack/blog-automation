/**
 * normalize — 비교용 문자열 정규화
 * trim → 소문자 → 연속 공백 → 대시 통일 → 따옴표 제거
 */
export function normalize(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/['"'"]/g, "");
}
