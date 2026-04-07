/**
 * corpus-selector — exemplar_index 기반 3-5개 선택 + summary artifact 생성
 *
 * 선택 기준 (가중 합산):
 *   relevance_score  0.40 — 큐레이션 시 부여된 관련성
 *   recency          0.25 — 최신성 (180일 감쇠)
 *   role_match       0.20 — 글 역할(personal-experience/how-to/review…) 일치
 *   intent_match     0.15 — 검색 의도 카테고리 일치
 *
 * 오래된 exemplar (> 180일) → staleWarnings 반환
 * 전체 corpus 로드 금지. master-writer에게는 summary artifact만 전달.
 */

import { readJsonFile, fileExists } from "@/lib/github/repository";
import { Paths } from "@/lib/github/paths";
import type { CorpusSampleMeta } from "@/lib/types/github-data";

// ============================================================
// exemplar index 타입
// ============================================================

export interface ExemplarEntry {
  sampleId: string;
  title: string;
  category: string;
  tags: string[];
  relevanceScore: number;
  styleNotes: string;
  excerpt: string;
  wordCount: number;
  publishedAt: string;
}

export interface ExemplarIndex {
  userId: string;
  exemplars: ExemplarEntry[];
  lastCurated: string;
}

// ============================================================
// summary artifact
// ============================================================

export interface CorpusSummaryArtifact {
  userId: string;
  selectedCount: number;
  styleProfile: {
    dominantTone: string;
    avgWordCount: number;
    signatureExpressions: string[];
    structurePattern: string;
    openingPattern: string;
  };
  exemplarExcerpts: Array<{
    sampleId: string;
    title: string;
    excerpt: string;
    styleNotes: string;
  }>;
  retrievalStrategy: "exemplar_index" | "fallback_recent";
  staleWarnings: string[];      // 오래된 exemplar 경고
  scoringBreakdown: Array<{     // 선택 근거 추적
    sampleId: string;
    finalScore: number;
    components: { relevance: number; recency: number; roleMatch: number; intentMatch: number };
  }>;
}

// ============================================================
// 상수
// ============================================================

const MIN_EXEMPLARS = 3;
const MAX_EXEMPLARS = 5;
const STALE_THRESHOLD_DAYS = 180;
const RECENCY_HALF_LIFE_DAYS = 90; // 90일마다 recency score가 절반으로 감소

const SCORE_WEIGHTS = {
  relevance: 0.40,
  recency: 0.25,
  roleMatch: 0.20,
  intentMatch: 0.15,
};

// ============================================================
// 검색 의도 분류 (material-change-detector와 동일 패턴)
// ============================================================

type SearchIntent = "how-to" | "review" | "list" | "comparison" | "informational" | "unknown";

const INTENT_PATTERNS: Record<string, RegExp> = {
  "how-to": /방법|하는법|따라하기|가이드|설치|만들기|준비/,
  "review": /후기|리뷰|사용기|솔직|내돈내산|직접|경험|써봤/,
  "list": /추천|TOP\s?\d|순위|리스트|\d+가지|\d+선|모음|정리/,
  "comparison": /vs|비교|차이|어느게|뭐가 낫|선택|고민/,
  "informational": /이란|란\?|정의|개념|뜻|이유|왜|원인|역사/,
};

function classifyIntent(text: string): SearchIntent {
  const lower = text.toLowerCase();
  for (const [intent, pattern] of Object.entries(INTENT_PATTERNS)) {
    if (pattern.test(lower)) return intent as SearchIntent;
  }
  return "unknown";
}

// ============================================================
// 글 역할(role) 분류
// ============================================================

type ArticleRole = "personal-experience" | "ranking" | "comparison" | "tutorial" | "informational" | "neutral";

const ROLE_PATTERNS: Record<string, RegExp> = {
  "personal-experience": /직접|내가|경험|후기|가봤|써봤|먹어봤|내돈내산/,
  "ranking": /TOP\s?\d|\d+선|순위|베스트|최고|추천 \d/,
  "comparison": /비교|vs|차이|어느|어떤게/,
  "tutorial": /방법|하는법|따라하|가이드|단계|순서대로/,
  "informational": /이란|정의|개념|뜻|원인|역사|종류/,
};

function _classifyRole(title: string, tags: string[] = []): ArticleRole {
  const text = `${title} ${tags.join(" ")}`.toLowerCase();
  for (const [role, pattern] of Object.entries(ROLE_PATTERNS)) {
    if (pattern.test(text)) return role as ArticleRole;
  }
  return "neutral";
}

// ============================================================
// 점수 계산
// ============================================================

function recencyScore(publishedAt: string): number {
  const ageMs = Date.now() - new Date(publishedAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  // 지수 감쇠: score = 0.5^(ageDays / halfLife)
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

function roleMatchScore(entry: ExemplarEntry, targetCategory?: string, targetTags?: string[]): number {
  if (!targetCategory && (!targetTags || targetTags.length === 0)) return 0.5;

  let score = 0;
  if (targetCategory && entry.category === targetCategory) score += 0.6;
  if (targetTags && targetTags.length > 0) {
    const matchCount = targetTags.filter((t) => entry.tags.includes(t)).length;
    score += (matchCount / Math.max(targetTags.length, 1)) * 0.4;
  }
  return Math.min(score, 1);
}

function intentMatchScore(entry: ExemplarEntry, targetIntent?: string): number {
  if (!targetIntent || targetIntent === "unknown") return 0.5;
  const entryIntent = classifyIntent(`${entry.title} ${entry.tags.join(" ")}`);
  if (entryIntent === "unknown") return 0.5;
  return entryIntent === targetIntent ? 1 : 0;
}

interface ScoredExemplar {
  entry: ExemplarEntry;
  finalScore: number;
  components: { relevance: number; recency: number; roleMatch: number; intentMatch: number };
  isStale: boolean;
}

export function scoreExemplar(
  entry: ExemplarEntry,
  context: { targetCategory?: string; targetTags?: string[]; targetIntent?: string }
): ScoredExemplar {
  const relevance = Math.min(Math.max(entry.relevanceScore, 0), 1);
  const recency = recencyScore(entry.publishedAt);
  const roleMatch = roleMatchScore(entry, context.targetCategory, context.targetTags);
  const intentMatch = intentMatchScore(entry, context.targetIntent);

  const finalScore =
    relevance * SCORE_WEIGHTS.relevance +
    recency * SCORE_WEIGHTS.recency +
    roleMatch * SCORE_WEIGHTS.roleMatch +
    intentMatch * SCORE_WEIGHTS.intentMatch;

  const ageDays = (Date.now() - new Date(entry.publishedAt).getTime()) / (1000 * 60 * 60 * 24);

  return {
    entry,
    finalScore,
    components: { relevance, recency, roleMatch, intentMatch },
    isStale: ageDays > STALE_THRESHOLD_DAYS,
  };
}

// ============================================================
// exemplar 선택
// ============================================================

export async function selectExemplars(params: {
  userId: string;
  category?: string;
  tags?: string[];
  targetCount?: number;
  topicTitle?: string;  // 검색 의도 분류용
}): Promise<{
  exemplars: ExemplarEntry[];
  strategy: "exemplar_index" | "fallback_recent";
  staleWarnings: string[];
  scoringBreakdown: ScoredExemplar[];
}> {
  const { userId, category, tags, targetCount = MAX_EXEMPLARS, topicTitle } = params;
  const count = Math.min(Math.max(targetCount, MIN_EXEMPLARS), MAX_EXEMPLARS);
  const targetIntent = topicTitle ? classifyIntent(topicTitle) : "unknown";

  const exemplarPath = Paths.exemplarIndex(userId);

  if (await fileExists(exemplarPath)) {
    const { data: index } = await readJsonFile<ExemplarIndex>(exemplarPath);

    const scored = index.exemplars.map((e) =>
      scoreExemplar(e, { targetCategory: category, targetTags: tags, targetIntent })
    );

    const selected = scored
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, count);

    const staleWarnings = selected
      .filter((s) => s.isStale)
      .map(
        (s) =>
          `exemplar "${s.entry.title}" (${s.entry.sampleId}) — ${Math.round((Date.now() - new Date(s.entry.publishedAt).getTime()) / (1000 * 60 * 60 * 24))}일 경과`
      );

    return {
      exemplars: selected.map((s) => s.entry),
      strategy: "exemplar_index",
      staleWarnings,
      scoringBreakdown: selected,
    };
  }

  // fallback: corpus index에서 최신 순
  const corpusIndexPath = Paths.corpusIndex(userId);
  if (!(await fileExists(corpusIndexPath))) {
    return { exemplars: [], strategy: "fallback_recent", staleWarnings: [], scoringBreakdown: [] };
  }

  const { data: corpusIndex } = await readJsonFile<{ samples: CorpusSampleMeta[] }>(corpusIndexPath);
  const recent = corpusIndex.samples
    .sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime())
    .slice(0, count);

  const fallbackExemplars: ExemplarEntry[] = recent.map((s) => ({
    sampleId: s.sampleId,
    title: s.title,
    category: s.category,
    tags: s.tags,
    relevanceScore: 0.5,
    styleNotes: "fallback — 스타일 메모 없음",
    excerpt: "(corpus 로드 필요)",
    wordCount: s.wordCount,
    publishedAt: s.publishedAt,
  }));

  const staleWarnings = fallbackExemplars
    .filter((e) => {
      const ageDays = (Date.now() - new Date(e.publishedAt).getTime()) / (1000 * 60 * 60 * 24);
      return ageDays > STALE_THRESHOLD_DAYS;
    })
    .map((e) => `fallback exemplar "${e.title}" (${e.sampleId}) — 오래된 항목`);

  return {
    exemplars: fallbackExemplars,
    strategy: "fallback_recent",
    staleWarnings,
    scoringBreakdown: [],
  };
}

// ============================================================
// summary artifact 생성
// ============================================================

const SIGNATURE_PATTERNS = [
  /직접 경험한|오늘은 제가|솔직하게 말씀드리면|정말 도움이 됐어요/g,
  /꼭 추천드려요|안녕하세요|여러분께/g,
];

function extractSignatureExpressions(excerpts: string[]): string[] {
  const found = new Set<string>();
  for (const text of excerpts) {
    for (const pattern of SIGNATURE_PATTERNS) {
      const matches = text.match(pattern) ?? [];
      matches.forEach((m) => found.add(m));
    }
  }
  return [...found].slice(0, 5);
}

function inferStructurePattern(excerpts: string[]): string {
  const hasNumberedList = excerpts.some((e) => /^\d+\./m.test(e));
  const hasSections = excerpts.some((e) => /^##/m.test(e));
  const hasQuestions = excerpts.some((e) => /\?/.test(e));
  if (hasNumberedList) return "목록형 (번호 사용)";
  if (hasSections) return "섹션형 (##헤딩 사용)";
  if (hasQuestions) return "질문-답변형";
  return "서술형 (자연스러운 단락)";
}

function inferOpeningPattern(excerpts: string[]): string {
  if (excerpts.length === 0) return "알 수 없음";
  const first = excerpts[0].slice(0, 80);
  if (/안녕하세요/.test(first)) return "인사로 시작";
  if (/오늘은/.test(first)) return "오늘 주제 소개로 시작";
  if (/\?/.test(first)) return "질문으로 시작";
  return "주제 직접 서술로 시작";
}

export function buildSummaryArtifact(params: {
  userId: string;
  exemplars: ExemplarEntry[];
  strategy: "exemplar_index" | "fallback_recent";
  userTone?: string;
  staleWarnings?: string[];
  scoringBreakdown?: ScoredExemplar[];
}): CorpusSummaryArtifact {
  const { userId, exemplars, strategy, userTone, staleWarnings = [], scoringBreakdown = [] } = params;

  const excerpts = exemplars.map((e) => e.excerpt).filter(Boolean);
  const avgWordCount =
    exemplars.length > 0
      ? Math.round(exemplars.reduce((acc, e) => acc + e.wordCount, 0) / exemplars.length)
      : 0;

  return {
    userId,
    selectedCount: exemplars.length,
    styleProfile: {
      dominantTone: userTone ?? "friendly",
      avgWordCount,
      signatureExpressions: extractSignatureExpressions(excerpts),
      structurePattern: inferStructurePattern(excerpts),
      openingPattern: inferOpeningPattern(excerpts),
    },
    exemplarExcerpts: exemplars.map((e) => ({
      sampleId: e.sampleId,
      title: e.title,
      excerpt: e.excerpt,
      styleNotes: e.styleNotes,
    })),
    retrievalStrategy: strategy,
    staleWarnings,
    scoringBreakdown: scoringBreakdown.map((s) => ({
      sampleId: s.entry.sampleId,
      finalScore: Math.round(s.finalScore * 1000) / 1000,
      components: {
        relevance: Math.round(s.components.relevance * 100) / 100,
        recency: Math.round(s.components.recency * 100) / 100,
        roleMatch: Math.round(s.components.roleMatch * 100) / 100,
        intentMatch: Math.round(s.components.intentMatch * 100) / 100,
      },
    })),
  };
}

// ============================================================
// 통합 함수
// ============================================================

export async function getCorpusSummary(params: {
  userId: string;
  category?: string;
  tags?: string[];
  userTone?: string;
  topicTitle?: string;
}): Promise<CorpusSummaryArtifact> {
  const { exemplars, strategy, staleWarnings, scoringBreakdown } = await selectExemplars({
    userId: params.userId,
    category: params.category,
    tags: params.tags,
    topicTitle: params.topicTitle,
  });

  return buildSummaryArtifact({
    userId: params.userId,
    exemplars,
    strategy,
    userTone: params.userTone,
    staleWarnings,
    scoringBreakdown,
  });
}
