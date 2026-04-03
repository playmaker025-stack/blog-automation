/**
 * import-parser — 글목록(topics) 및 발행 인덱스(posts) TXT 파싱
 *
 * 인코딩 자동 감지:
 *   1. UTF-8로 읽기 시도
 *   2. 결과에 U+FFFD(대체 문자)가 포함되면 EUC-KR로 재시도
 */

// ── 인코딩 자동 감지 ─────────────────────────────────────────

export function readFileAutoEncoding(file: File): Promise<string> {
  return new Promise((resolve) => {
    const r1 = new FileReader();
    r1.onload = (ev) => {
      const text = (ev.target?.result as string) ?? "";
      if (text.includes("\uFFFD")) {
        const r2 = new FileReader();
        r2.onload = (ev2) => resolve((ev2.target?.result as string) ?? "");
        r2.readAsText(file, "euc-kr");
      } else {
        resolve(text);
      }
    };
    r1.readAsText(file, "utf-8");
  });
}

// ── 공통 반환 타입 ────────────────────────────────────────────

export interface ParseResult<T> {
  items: T[];
  parsed_count: number;
  duplicate_count: number;
  failed_count: number;
  warnings: string[];
}

// ── 글목록 파싱 ──────────────────────────────────────────────
// 형식:
//   A 블로그     ← 섹션 헤더
//   글제목1
//   글제목2

const BLOG_HEADER_RE = /^([A-Z])\s*(블로그|blog)\s*$/i;

export interface TopicItem {
  title: string;
  blog: string;
}

export function parseTopicText(text: string): ParseResult<TopicItem> {
  const src = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const items: TopicItem[] = [];
  const seenTitles = new Set<string>();
  const warnings: string[] = [];
  let currentBlog = "";
  let duplicate_count = 0;
  let failed_count = 0;

  for (const raw of src.split("\n")) {
    const l = raw.trim();
    if (!l) continue;

    const headerMatch = BLOG_HEADER_RE.exec(l);
    if (headerMatch) {
      currentBlog = headerMatch[1].toUpperCase();
      continue;
    }

    if (l.length < 2) {
      failed_count++;
      warnings.push(`너무 짧은 항목 제외: "${l}"`);
      continue;
    }

    const titleKey = l.toLowerCase();
    if (seenTitles.has(titleKey)) {
      duplicate_count++;
      warnings.push(`중복 제목 제외: "${l}"`);
      continue;
    }

    seenTitles.add(titleKey);
    items.push({ title: l, blog: currentBlog });
  }

  return { items, parsed_count: items.length, duplicate_count, failed_count, warnings };
}

// ── 발행 인덱스 파싱 (TSV) ───────────────────────────────────
// 형식 A (6컬럼): No / 블로그 / 날짜 / URL / 키워드 / 검색의도
// 형식 B (7컬럼): No / 블로그 / 날짜 / 글제목 / URL / 키워드 / 검색의도

export interface IndexItem {
  title: string;
  url: string;
  blog: string;
}

function parseTSVRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const src = text.startsWith("\uFEFF") ? text.slice(1) : text;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else { field += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === '\t') { row.push(field); field = ""; }
      else if (ch === '\n') {
        row.push(field); field = "";
        if (row.some((f) => f.trim())) rows.push(row);
        row = [];
      } else if (ch !== '\r') { field += ch; }
    }
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

export function parseIndexText(text: string): ParseResult<IndexItem> {
  const rows = parseTSVRows(text);
  const items: IndexItem[] = [];
  const seenTitles = new Set<string>();
  const seenUrls = new Set<string>();
  const warnings: string[] = [];
  let duplicate_count = 0;
  let failed_count = 0;

  for (const cols of rows) {
    const no = (cols[0] ?? "").trim();
    if (!/^\d+$/.test(no)) continue; // 헤더 행

    if (cols.length < 4) {
      failed_count++;
      warnings.push(`컬럼 부족 (행 ${no}): ${cols.length}개`);
      continue;
    }

    const rawBlog = (cols[1] ?? "").trim().toUpperCase();
    const blog = /^[A-E]$/.test(rawBlog) ? rawBlog : "";

    const c3 = (cols[3] ?? "").trim();
    const c4 = (cols[4] ?? "").trim();

    let title: string;
    let url: string;

    if (c3.startsWith("http")) {
      url = c3;
      title = c4 || url;
    } else {
      title = c3;
      url = c4.startsWith("http") ? c4 : "";
    }

    if (!title) {
      failed_count++;
      warnings.push(`제목 없음 (행 ${no})`);
      continue;
    }

    const titleKey = title.toLowerCase();
    const urlKey = url.toLowerCase();

    if (seenTitles.has(titleKey) || (urlKey && seenUrls.has(urlKey))) {
      duplicate_count++;
      warnings.push(`중복 항목 제외 (행 ${no}): "${title}"`);
      continue;
    }

    seenTitles.add(titleKey);
    if (urlKey) seenUrls.add(urlKey);
    items.push({ title, url, blog });
  }

  return { items, parsed_count: items.length, duplicate_count, failed_count, warnings };
}
