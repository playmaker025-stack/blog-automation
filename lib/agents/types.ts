import type { PipelineStage } from "@/lib/types/agent";

// ============================================================
// 파이프라인 실행 요청
// ============================================================

export interface PipelineRunRequest {
  topicId: string;
  userId: string;
}

// ============================================================
// SSE 이벤트
// ============================================================

export type SSEEventType =
  | "stage_change"
  | "progress"
  | "token"
  | "approval_required"
  | "gate_blocked"      // release gate fail — 배포 차단됨
  | "rejected"          // 사용자 전략 거절 — 재시도 가능
  | "result"
  | "error";

export interface SSEEvent {
  type: SSEEventType;
  stage: PipelineStage;
  data: unknown;
  timestamp: string;
}

// ============================================================
// 에이전트 결과
// ============================================================

export interface StrategyPlanResult {
  title: string;
  outline: Array<{
    heading: string;
    subPoints: string[];
    contentDirection: string;
    estimatedParagraphs: number;
  }>;
  keyPoints: string[];
  estimatedLength: number;
  tone: string;
  keywords: string[];
  suggestedSources: string[];
  rationale: string;
}

export interface WriterResult {
  postId: string;
  title: string;
  content: string; // 마크다운 본문
  wordCount: number;
  generatedAt: string;
}

export interface EvalResult {
  runId: string;
  scores: {
    originality: number;
    style_match: number;
    structure: number;
    engagement: number;
    forbidden_check: number;
  };
  aggregateScore: number;
  reasoning: Record<string, string>;
  recommendations: string[];
  pass: boolean; // aggregateScore >= 70
}

// ============================================================
// 승인 흐름
// ============================================================

export interface ApprovalPayload {
  pipelineId: string;
  previousTitle: string;
  proposedTitle: string;
  rationale: string;
}

export interface ApprovalRequest {
  pipelineId: string;
  approved: boolean;
  modifications?: string; // 거절 시 수정 요청 사항
}

// ============================================================
// 파이프라인 실행 상태 (in-memory + GitHub 저장)
// ============================================================

export interface PipelineState {
  pipelineId: string;
  topicId: string;
  userId: string;
  stage: PipelineStage;
  strategy: StrategyPlanResult | null;
  writerResult: WriterResult | null;
  evalResult: EvalResult | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
