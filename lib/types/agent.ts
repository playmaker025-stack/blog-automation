import type { MessageParam } from "@anthropic-ai/sdk/resources/messages";

// ============================================================
// 에이전트 공통
// ============================================================

export type AgentName =
  | "orchestrator"
  | "strategy-planner"
  | "master-writer"
  | "harness-evaluator";

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

// ============================================================
// 파이프라인 상태
// ============================================================

export type PipelineStage =
  | "idle"
  | "feasibility-check"
  | "strategy-planning"
  | "writing"
  | "evaluating"
  | "awaiting-approval"
  | "gate_blocked"     // post-audit gate fail — draft 저장됨, 배포 차단
  | "complete"
  | "failed";

export interface PipelineState {
  sessionId: string;
  userId: string;
  topicId: string;
  stage: PipelineStage;
  strategy: StrategyPlan | null;
  draftPostId: string | null;
  evalRunId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================
// Strategy Planner 출력
// ============================================================

export interface StrategyPlan {
  title: string;
  outline: OutlineSection[];
  keyPoints: string[];
  estimatedLength: number; // 목표 글자수
  tone: string;
  keywords: string[];
  suggestedSources: string[];
  rationale: string; // 전략 근거 설명
}

export interface OutlineSection {
  heading: string;
  subPoints: string[];
  contentDirection: string;
  estimatedParagraphs: number;
}

// ============================================================
// Master Writer 출력
// ============================================================

export interface WriterOutput {
  postId: string;
  title: string;
  content: string; // 마크다운 본문
  wordCount: number;
  generatedAt: string;
}

// ============================================================
// Harness Evaluator 출력
// ============================================================

export interface EvaluatorOutput {
  runId: string;
  scores: Record<string, number>;
  aggregateScore: number;
  reasoning: Record<string, string>;
  recommendations: string[];
}

// ============================================================
// SSE 스트리밍 이벤트
// ============================================================

export type StreamEventType =
  | "stage_change"
  | "text_delta"
  | "tool_use"
  | "tool_result"
  | "error"
  | "complete";

export interface StreamEvent {
  type: StreamEventType;
  data: unknown;
  timestamp: string;
}

export interface StageChangeEvent {
  stage: PipelineStage;
  message: string;
}

export interface TextDeltaEvent {
  delta: string;
}

export interface CompleteEvent {
  sessionId: string;
  postId: string | null;
  evalScore: number | null;
}

// ============================================================
// Tool Executor
// ============================================================

export type SkillFunction = (input: unknown) => Promise<unknown>;

export interface ToolRegistry {
  [toolName: string]: SkillFunction;
}

export interface ToolUseLoopOptions {
  model: string;
  system: string;
  messages: MessageParam[];
  tools: import("@anthropic-ai/sdk/resources/messages").Tool[];
  toolRegistry: ToolRegistry;
  maxIterations?: number; // 기본값: 10
  onProgress?: (msg: string) => void;
  signal?: AbortSignal; // 파이프라인 수준 취소 신호
}
