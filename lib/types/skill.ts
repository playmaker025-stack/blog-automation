import type { CorpusSample, UserProfile, ForbiddenExpressions, PostingRecord, Topic } from "./github-data";
import type { OutlineSection } from "./agent";

// ============================================================
// source-resolver
// ============================================================

export interface SourceResolverInput {
  urls: string[];
}

export interface ResolvedSource {
  url: string;
  title: string;
  excerpt: string;
  accessible: boolean;
  error?: string;
}

export interface SourceResolverOutput {
  resolved: ResolvedSource[];
}

// ============================================================
// topic-feasibility-judge
// ============================================================

export interface TopicFeasibilityInput {
  topic: Topic;
  userProfile: UserProfile;
  forbiddenExpressions: ForbiddenExpressions;
}

export interface TopicFeasibilityOutput {
  score: number; // 0–100
  verdict: "feasible" | "uncertain" | "blocked";
  reasons: string[];
}

// ============================================================
// user-profile-loader
// ============================================================

export interface UserProfileLoaderInput {
  userId: string;
}

export interface UserProfileLoaderOutput {
  profile: UserProfile;
  forbiddenExpressions: ForbiddenExpressions;
}

// ============================================================
// user-corpus-retriever
// ============================================================

export interface UserCorpusRetrieverInput {
  userId: string;
  limit?: number; // 기본값: 5
  category?: string; // 특정 카테고리 필터
  tags?: string[]; // 태그 필터
}

export interface UserCorpusRetrieverOutput {
  samples: CorpusSample[];
  totalAvailable: number;
}

// ============================================================
// expansion-planner
// ============================================================

export interface ExpansionPlannerInput {
  outline: OutlineSection[];
  targetLength: number; // 목표 글자수
  tone: string;
  keywords: string[];
}

export interface ExpandedSection {
  heading: string;
  subPoints: string[];
  contentDirection: string;
  expandedNotes: string[]; // 상세 작성 방향
  estimatedParagraphs: number;
  keywordsToInclude: string[];
}

export interface ExpansionPlannerOutput {
  expandedOutline: ExpandedSection[];
  totalEstimatedLength: number;
}

// ============================================================
// review-record-audit
// ============================================================

export interface ReviewRecordAuditInput {
  userId: string;
  limit?: number; // 최근 N개 포스팅, 기본값: 10
}

export interface ReviewRecordAuditOutput {
  summary: string; // 패턴 요약
  topPerformingCategories: string[];
  averageScoreByCategory: Record<string, number>;
  recentPosts: PostingRecord[];
  gaps: string[]; // 다루지 않은 영역
}
