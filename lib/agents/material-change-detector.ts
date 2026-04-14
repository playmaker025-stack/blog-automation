/**
 * material_change 4-signal 감지기
 *
 * 레벤슈타인 유사도는 보조 지표 — 단독 판정 금지.
 * 아래 4가지를 종합해 material_change 여부를 결정한다.
 *
 *   1. search_intent   — 검색 의도 카테고리 변경 (정보형→방법형 등)
 *   2. core_keyword    — 핵심 키워드(주제어) 교체 여부
 *   3. article_angle   — 글의 관점/접근 방식 변경 (경험→비교 등)
 *   4. decision_logic  — 글 구조 패턴 변경 (목록→단일 등)
 *
 * signal이 2개 이상이면 material_change = true.
 * 단, 레벤슈타인 유사도가 0.85 이상이면 모든 signal 무시 (오탐 방지).
 */

// ============================================================
// 타입
// ============================================================

export interface MaterialChangeInput {
  original: {
    title: string;
    keywords?: string[];   // strategy-planner 출력 키워드
    intent?: string;       // 토픽 설명 또는 검색 의도
  };
  proposed: {
    title: string;
    keywords?: string[];
    rationale?: string;    // strategy-planner 근거
  };
}

export interface MaterialChangeSignals {
  searchIntentChanged: boolean;
  coreKeywordChanged: boolean;
  articleAngleChanged: boolean;
  decisionLogicChanged: boolean;
  stringSimilarity: number; // 0-1, 보조 지표
}

export interface MaterialChangeResult {
  isMaterial: boolean;
  signals: MaterialChangeSignals;
  triggeredSignals: string[];
  reason: string;
  stringSimilarity: number;  // 최종 유사도 (로그/추적용)
}

// ============================================================
// 1. search_intent 분류기
// ============================================================

type SearchIntent = "informational" | "how-to" | "review" | "list" | "comparison" | "unknown";

const INTENT_PATTERNS: Record<SearchIntent, RegExp[]> = {
  "how-to": [/방법|하는법|따라하기|가이드|하는 방법|설치|만들기|준비/],
  "review": [/후기|리뷰|사용기|솔직|내돈내산|직접|경험|써봤/],
  "list": [/추천|TOP\s?\d|순위|리스트|\d+가지|\d+선|모음|정리|베스트/],
  "comparison": [/vs|비교|차이|어느게|뭐가 낫|선택|고민/],
  "informational": [/이란|란\?|정의|개념|뜻|이유|왜|원인|역사|종류/],
  "unknown": [],
};

function classifyIntent(text: string): SearchIntent {
  const lower = text.toLowerCase();
  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS) as [SearchIntent, RegExp[]][]) {
    if (intent === "unknown") continue;
    if (patterns.some((p) => p.test(lower))) return intent;
  }
  return "unknown";
}

function isIntentChanged(a: string, b: string, intentHint?: string): boolean {
  const combined = `${a} ${intentHint ?? ""}`.trim();
  const intentA = classifyIntent(combined);
  const intentB = classifyIntent(b);
  if (intentA === "unknown" || intentB === "unknown") return false;
  return intentA !== intentB;
}

// ============================================================
// 2. core_keyword 추출기 (주제어 = 명사/지명/브랜드)
// ============================================================

const STOPWORDS = new Set([
  "완벽", "정리", "추천", "후기", "리뷰", "직접", "솔직", "가이드", "방법",
  "이유", "종류", "정보", "총정리", "가본", "살펴보는", "알아보는", "써봤",
  "서울", "부산", "제주", "인천", // 지역어는 핵심 키워드에 포함
]);

function extractCoreKeywords(title: string): string[] {
  // 한국어 단어 단위 분리 (공백·특수문자 기준)
  const tokens = title
    .replace(/[^\w\s가-힣]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2)
    .map((t) => t.toLowerCase());

  // stopword 제거 후 상위 키워드 반환
  return tokens.filter((t) => !STOPWORDS.has(t));
}

function isCoreKeywordChanged(
  originalTitle: string,
  proposedTitle: string,
  originalKws?: string[],
  proposedKws?: string[]
): boolean {
  const okws = [
    ...(originalKws ?? []),
    ...extractCoreKeywords(originalTitle),
  ].map((k) => k.toLowerCase());

  const pkws = [
    ...(proposedKws ?? []),
    ...extractCoreKeywords(proposedTitle),
  ].map((k) => k.toLowerCase());

  if (okws.length === 0 || pkws.length === 0) return false;

  const shared = okws.filter((k) => pkws.some((pk) => pk.includes(k) || k.includes(pk)));
  const overlapRatio = shared.length / Math.max(okws.length, pkws.length);

  // 공통 키워드가 30% 미만이면 핵심 키워드 교체로 판단
  return overlapRatio < 0.30;
}

// ============================================================
// 3. article_angle 분류기
// ============================================================

type ArticleAngle = "personal-experience" | "ranking" | "comparison" | "tutorial" | "neutral";

const ANGLE_PATTERNS: Record<ArticleAngle, RegExp[]> = {
  "personal-experience": [/직접|내가|경험|후기|가봤|써봤|먹어봤/],
  "ranking": [/TOP\s?\d|\d+선|순위|베스트|최고|추천 \d/],
  "comparison": [/비교|vs|차이|어느|어떤게/],
  "tutorial": [/방법|하는법|따라하|가이드|단계|순서대로/],
  "neutral": [],
};

function classifyAngle(text: string): ArticleAngle {
  const lower = text.toLowerCase();
  for (const [angle, patterns] of Object.entries(ANGLE_PATTERNS) as [ArticleAngle, RegExp[]][]) {
    if (angle === "neutral") continue;
    if (patterns.some((p) => p.test(lower))) return angle;
  }
  return "neutral";
}

function isAngleChanged(originalTitle: string, proposedTitle: string): boolean {
  const angleA = classifyAngle(originalTitle);
  const angleB = classifyAngle(proposedTitle);
  if (angleA === "neutral" || angleB === "neutral") return false;
  return angleA !== angleB;
}

// ============================================================
// 4. decision_logic 분류기 (글 구조 패턴)
// ============================================================

type DecisionLogic = "single-topic" | "multi-item" | "pros-cons" | "timeline" | "neutral";

const LOGIC_PATTERNS: Record<DecisionLogic, RegExp[]> = {
  "multi-item": [/\d+가지|\d+개|\d+곳|목록|모음|리스트/],
  "pros-cons": [/장단점|장점|단점|좋은점|나쁜점|pros|cons/],
  "timeline": [/과정|히스토리|역사|변천사|단계|순서/],
  "single-topic": [/이란|뜻|정의|개념|완벽 정리/],
  "neutral": [],
};

function classifyLogic(text: string): DecisionLogic {
  const lower = text.toLowerCase();
  for (const [logic, patterns] of Object.entries(LOGIC_PATTERNS) as [DecisionLogic, RegExp[]][]) {
    if (logic === "neutral") continue;
    if (patterns.some((p) => p.test(lower))) return logic;
  }
  return "neutral";
}

function isDecisionLogicChanged(originalTitle: string, proposedTitle: string, rationale?: string): boolean {
  const logicA = classifyLogic(originalTitle);
  const logicB = classifyLogic(`${proposedTitle} ${rationale ?? ""}`);
  if (logicA === "neutral" || logicB === "neutral") return false;
  return logicA !== logicB;
}

// ============================================================
// 5. 레벤슈타인 유사도 (보조 지표)
// ============================================================

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0
    )
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

export function stringSimilarity(a: string, b: string): number {
  const s1 = a.toLowerCase().replace(/\s+/g, "");
  const s2 = b.toLowerCase().replace(/\s+/g, "");
  if (s1 === s2) return 1;
  if (!s1.length || !s2.length) return 0;
  return 1 - levenshtein(s1, s2) / Math.max(s1.length, s2.length);
}

// ============================================================
// 메인 감지 함수
// ============================================================

export function detectMaterialChange(input: MaterialChangeInput): MaterialChangeResult {
  const { original, proposed } = input;

  // 원본 없음 → 신규 토픽, material_change 없음
  if (!original.title) {
    return {
      isMaterial: false,
      signals: { searchIntentChanged: false, coreKeywordChanged: false, articleAngleChanged: false, decisionLogicChanged: false, stringSimilarity: 1 },
      triggeredSignals: [],
      reason: "원본 제목 없음 — 신규 토픽",
      stringSimilarity: 1,
    };
  }

  // proposed.title 없음 → 파싱 실패 케이스, material_change 없음으로 처리
  if (!proposed.title) {
    return {
      isMaterial: false,
      signals: { searchIntentChanged: false, coreKeywordChanged: false, articleAngleChanged: false, decisionLogicChanged: false, stringSimilarity: 0 },
      triggeredSignals: [],
      reason: "제안 제목 없음 — 전략 파싱 실패로 인한 안전 처리",
      stringSimilarity: 0,
    };
  }

  const sim = stringSimilarity(original.title, proposed.title);

  // 문자열이 거의 동일(≥0.85)하면 오탐 방지 — signal 무시
  if (sim >= 0.85) {
    return {
      isMaterial: false,
      signals: { searchIntentChanged: false, coreKeywordChanged: false, articleAngleChanged: false, decisionLogicChanged: false, stringSimilarity: sim },
      triggeredSignals: [],
      reason: `문자열 유사도 ${sim.toFixed(2)} ≥ 0.85 — 실질적 변경 없음`,
      stringSimilarity: sim,
    };
  }

  const signals: MaterialChangeSignals = {
    searchIntentChanged: isIntentChanged(original.title, proposed.title, original.intent),
    coreKeywordChanged: isCoreKeywordChanged(original.title, proposed.title, original.keywords, proposed.keywords),
    articleAngleChanged: isAngleChanged(original.title, proposed.title),
    decisionLogicChanged: isDecisionLogicChanged(original.title, proposed.title, proposed.rationale),
    stringSimilarity: sim,
  };

  const triggered = (Object.entries(signals) as [string, boolean | number][])
    .filter(([k, v]) => k !== "stringSimilarity" && v === true)
    .map(([k]) => k);

  // 2개 이상의 signal이 발화하면 material_change
  const isMaterial = triggered.length >= 2;

  const reason = isMaterial
    ? `material_change 판정 (${triggered.length}개 signal 발화: ${triggered.join(", ")})`
    : `material_change 아님 (${triggered.length}개 signal 발화: ${triggered.join(", ") || "없음"}, 유사도: ${sim.toFixed(2)})`;

  return { isMaterial, signals, triggeredSignals: triggered, reason, stringSimilarity: sim };
}
