// ============================================================
// 사용자 프로필
// ============================================================

export interface UserProfile {
  userId: string;
  displayName: string;
  naverBlogUrl: string;
  writingStyle: {
    tone: "formal" | "casual" | "friendly" | "professional";
    averagePostLength: number; // 목표 글자수 (한국어 기준)
    preferredStructure: "narrative" | "listicle" | "how-to" | "review";
    signatureExpressions: string[]; // 자주 쓰는 표현/문구
  };
  targetAudience: {
    ageRange: string; // e.g. "20-30대"
    interests: string[];
    knowledgeLevel: "beginner" | "intermediate" | "expert";
  };
  githubDataRepo: string; // "owner/repo"
  createdAt: string; // ISO 8601
  updatedAt: string;
}

// ============================================================
// 금지 표현
// ============================================================

export interface ForbiddenExpressions {
  userId: string;
  expressions: ForbiddenEntry[];
  updatedAt: string;
}

export interface ForbiddenEntry {
  pattern: string; // 금지 표현 또는 정규식 패턴
  reason: string; // 금지 이유
  isRegex: boolean;
}

// ============================================================
// 코퍼스
// ============================================================

export interface CorpusSampleMeta {
  sampleId: string;
  title: string;
  category: string;
  tags: string[];
  wordCount: number;
  publishedAt: string;
  filePath: string; // 리포 내 상대 경로
}

export interface CorpusIndex {
  userId: string;
  samples: CorpusSampleMeta[];
  lastUpdated: string;
}

export interface CorpusSample {
  meta: CorpusSampleMeta;
  content: string; // 마크다운 본문
}

// ============================================================
// 토픽 인덱스
// ============================================================

export interface Topic {
  topicId: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  feasibility: TopicFeasibility | null;
  relatedSources: string[]; // 참조 URL 목록
  status: "draft" | "planned" | "in-progress" | "published" | "archived";
  assignedUserId: string | null; // 담당 사용자
  createdAt: string;
  updatedAt: string;
}

export interface TopicFeasibility {
  score: number; // 0–100
  verdict: "feasible" | "uncertain" | "blocked";
  reasons: string[];
  checkedAt: string;
}

export interface TopicIndex {
  topics: Topic[];
  lastUpdated: string;
}

// ============================================================
// 포스팅 목록
// ============================================================

export type PostStatus = "draft" | "ready" | "approved" | "audit_failed" | "published" | "failed";

export interface PostingRecord {
  postId: string;
  topicId: string;
  userId: string;
  title: string;
  status: PostStatus;
  naverPostUrl: string | null;
  evalScore: number | null; // 종합 품질 점수 0–100
  wordCount: number;
  compositionSessionId: string | null;
  pendingApproval: PendingApproval | null; // 승인 대기 상태
  createdAt: string;
  publishedAt: string | null;
  updatedAt: string;
}

export interface PendingApproval {
  requestedAt: string;
  changeType: "title" | "direction" | "both";
  previousTitle: string;
  proposedTitle: string;
  reason: string;
}

export interface PostingIndex {
  posts: PostingRecord[];
  lastUpdated: string;
}

// ============================================================
// 평가
// ============================================================

export interface EvalCase {
  caseId: string;
  name: string;
  description: string;
  inputTopicId: string;
  goldenCriteria: EvalCriterion[];
  createdAt: string;
}

export interface EvalCriterion {
  dimension: "originality" | "style_match" | "structure" | "engagement" | "forbidden_check";
  weight: number; // 0–1, 전체 합계 = 1
  rubric: string; // 자연어 채점 기준
}

export interface EvalCaseIndex {
  cases: EvalCase[];
  lastUpdated: string;
}

export interface BaselineResult {
  runId: string;
  caseId: string;
  postId: string;
  runAt: string;
  scores: Record<string, number>; // dimension → 0–100
  aggregateScore: number;
  notes: string;
}

export interface BaselineIndex {
  results: BaselineResult[];
  lastUpdated: string;
}

export interface EvalRun {
  runId: string;
  caseId: string;
  postId: string;
  runAt: string;
  scores: Record<string, number>;
  aggregateScore: number;
  reasoning: Record<string, string>; // dimension → 근거
  comparedToBaseline: number | null; // 기준선 대비 델타
}
