import type {
  TopicFeasibilityInput,
  TopicFeasibilityOutput,
} from "@/lib/types/skill";

/**
 * 토픽 실현 가능성 판단 스킬
 *
 * 순수 휴리스틱 함수 — LLM 호출 없음 (빠른 게이트 역할).
 * - 금지 표현이 토픽 제목/설명에 포함되면 blocked 처리
 * - 대상 독자 적합성 확인
 * - avoidTopics 키워드 매칭
 */
export function topicFeasibilityJudge(
  input: TopicFeasibilityInput
): TopicFeasibilityOutput {
  const { topic, userProfile, forbiddenExpressions } = input;

  const reasons: string[] = [];
  let score = 100;

  const topicText = `${topic.title} ${topic.description}`.toLowerCase();

  // 1. 금지 표현 검사
  for (const entry of forbiddenExpressions.expressions) {
    let matched = false;
    if (entry.isRegex) {
      try {
        matched = new RegExp(entry.pattern, "i").test(topicText);
      } catch {
        // 잘못된 정규식은 무시
      }
    } else {
      matched = topicText.includes(entry.pattern.toLowerCase());
    }

    if (matched) {
      score -= 50;
      reasons.push(`금지 표현 포함: "${entry.pattern}" (사유: ${entry.reason})`);
    }
  }

  // 2. avoidTopics 키워드 매칭 (writingStyle에 없으므로 태그 기반으로 확인)
  // UserProfile에 avoidTopics가 없으므로 향후 확장 지점
  // 현재는 스킵

  // 3. 토픽 상태 확인
  if (topic.status === "archived") {
    score -= 30;
    reasons.push("토픽이 보관(archived) 상태입니다.");
  }

  // 4. 목표 독자 적합성 — 태그와 관심사 교집합
  const audienceInterests = userProfile.targetAudience.interests.map((i) =>
    i.toLowerCase()
  );
  const topicTags = topic.tags.map((t) => t.toLowerCase());
  const hasAudienceMatch = topicTags.some((tag) =>
    audienceInterests.some((interest) => tag.includes(interest) || interest.includes(tag))
  );
  if (!hasAudienceMatch && audienceInterests.length > 0) {
    score -= 10;
    reasons.push("토픽 태그와 타깃 독자 관심사 간 교집합이 없습니다.");
  }

  const clampedScore = Math.max(0, Math.min(100, score));

  let verdict: TopicFeasibilityOutput["verdict"];
  if (clampedScore >= 70) {
    verdict = "feasible";
  } else if (clampedScore >= 40) {
    verdict = "uncertain";
  } else {
    verdict = "blocked";
  }

  if (reasons.length === 0) {
    reasons.push("검토 이슈 없음.");
  }

  return { score: clampedScore, verdict, reasons };
}
