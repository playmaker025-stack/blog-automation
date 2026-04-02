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

// ── 글목록 파싱 ──────────────────────────────────────────────
// 형식:
//   A 블로그     ← 섹션 헤더 → 이하 항목의 blog="A"
//   글제목1
//   글제목2
//   B 블로그
//   글제목3

const BLOG_HEADER_RE = /^([A-Z])\s*(블로그|blog)\s*$/i;

export interface TopicItem {
  title: string;
  blog: string; // "A" | "B" | ... | ""
}

export interface TopicParseResult {
  items: TopicItem[];
  parsed: number;
  skipped: number;
}

export function parseTopicText(text: string): TopicParseResult {
  const src = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const items: TopicItem[] = [];
  let currentBlog = "";
  let skipped = 0;

  for (const raw of src.split("\n")) {
    const l = raw.trim();
    if (!l) continue;

    const headerMatch = BLOG_HEADER_RE.exec(l);
    if (headerMatch) {
      currentBlog = headerMatch[1].toUpperCase();
      continue;
    }

    if (l.length < 2) { skipped++; continue; }
    items.push({ title: l, blog: currentBlog });
  }

  return { items, parsed: items.length, skipped };
}

// ── 발행 인덱스 파싱 (TSV) ───────────────────────────────────
// 형식 A (6컬럼): No / 블로그 / 날짜 / URL / 키워드 / 검색의도
//   col[3]=URL, col[4]=키워드(→title)
// 형식 B (7컬럼): No / 블로그 / 날짜 / 글제목 / URL / 키워드 / 검색의도
//   col[3]=title, col[4]=URL
// col[3]이 "http"로 시작하면 형식 A

export interface IndexItem {
  title: string;
  url: string;
  blog: string; // "A" | "B" | ... | ""
}

export interface IndexParseResult {
  items: IndexItem[];
  parsed: number;
  skipped: number;
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

export function parseIndexText(text: string): IndexParseResult {
  const rows = parseTSVRows(text);
  const items: IndexItem[] = [];
  let skipped = 0;

  for (const cols of rows) {
    const no = (cols[0] ?? "").trim();
    if (!/^\d+$/.test(no)) continue;

    if (cols.length < 4) { skipped++; continue; }

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

    if (!title) { skipped++; continue; }
    items.push({ title, url, blog });
  }

  return { items, parsed: items.length, skipped };
}
