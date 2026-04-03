/**
 * blogCode — category 문자열에서 블로그 코드(A~E) 추출
 * "A블로그" → "A", "B blog" → "B", 그 외 → null
 */
export function blogCode(category: string): string | null {
  const m = /^([A-Ea-e])\s*(블로그|blog)\s*$/i.exec(category.trim());
  return m ? m[1].toUpperCase() : null;
}

/**
 * userId → 블로그 코드 (a → "A", b → "B", ...)
 * userId가 단일 영문자 a~e 이면 대문자로 변환, 아니면 userId 자체를 대문자로
 */
export function userIdToBlogCode(userId: string): string {
  return userId.trim().toUpperCase().slice(0, 1) || "";
}
