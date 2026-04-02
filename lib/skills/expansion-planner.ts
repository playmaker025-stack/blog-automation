import type {
  ExpansionPlannerInput,
  ExpansionPlannerOutput,
  ExpandedSection,
} from "@/lib/types/skill";

const AVG_CHARS_PER_PARAGRAPH = 300; // 한국어 기준 단락당 평균 글자수

/**
 * 아웃라인 확장 계획 스킬
 *
 * strategy-planner가 생성한 아웃라인을 받아
 * 각 섹션별 상세 작성 방향과 키워드 배분을 계획한다.
 * 순수 함수 — LLM 호출 없음.
 */
export function expansionPlanner(
  input: ExpansionPlannerInput
): ExpansionPlannerOutput {
  const { outline, targetLength, keywords } = input;

  const totalParagraphsNeeded = Math.ceil(targetLength / AVG_CHARS_PER_PARAGRAPH);
  const paragraphsPerSection = Math.max(
    1,
    Math.floor(totalParagraphsNeeded / outline.length)
  );

  // 키워드를 섹션 수에 맞게 분배
  const keywordChunks = distributeKeywords(keywords, outline.length);

  const expandedOutline: ExpandedSection[] = outline.map((section, idx) => {
    const keywordsForSection = keywordChunks[idx] ?? [];
    const estimatedParagraphs = section.estimatedParagraphs || paragraphsPerSection;

    const expandedNotes = buildExpandedNotes(
      section,
      estimatedParagraphs,
      keywordsForSection,
      input.tone
    );

    return {
      heading: section.heading,
      subPoints: section.subPoints,
      contentDirection: section.contentDirection,
      expandedNotes,
      estimatedParagraphs,
      keywordsToInclude: keywordsForSection,
    };
  });

  const totalEstimatedLength = expandedOutline.reduce(
    (acc, s) => acc + s.estimatedParagraphs * AVG_CHARS_PER_PARAGRAPH,
    0
  );

  return { expandedOutline, totalEstimatedLength };
}

function distributeKeywords(keywords: string[], sectionCount: number): string[][] {
  if (sectionCount === 0) return [];
  const result: string[][] = Array.from({ length: sectionCount }, () => []);
  keywords.forEach((kw, i) => {
    result[i % sectionCount].push(kw);
  });
  return result;
}

function buildExpandedNotes(
  section: { heading: string; subPoints: string[]; contentDirection: string },
  paragraphs: number,
  keywords: string[],
  tone: string
): string[] {
  const notes: string[] = [];

  notes.push(`"${section.heading}" 섹션: ${paragraphs}개 단락 목표.`);
  notes.push(`톤: ${tone}. 지시사항: ${section.contentDirection}`);

  if (section.subPoints.length > 0) {
    notes.push(`포함할 하위 포인트: ${section.subPoints.join(", ")}`);
  }

  if (keywords.length > 0) {
    notes.push(`이 섹션에 자연스럽게 녹여야 할 키워드: ${keywords.join(", ")}`);
  }

  notes.push("서두에 직접적인 주장이나 질문으로 독자의 관심을 끌 것.");
  notes.push("마지막 단락은 다음 섹션으로 자연스럽게 이어지도록 마무리할 것.");

  return notes;
}
