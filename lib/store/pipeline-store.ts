import { create } from "zustand";
import type { PipelineStage } from "@/lib/types/agent";
import type { SSEEvent, StrategyPlanResult } from "@/lib/agents/types";
import { INITIAL_INSPECTOR_STATE } from "@/components/pipeline/state-inspector";
import type { InspectorState } from "@/components/pipeline/state-inspector";

// 인메모리 스토어 — persist 없음
// - 탭 이동(언마운트/마운트) 후에도 상태 유지 (모듈 싱글턴)
// - F5(전체 리로드) 시 초기화 → 사용자 격리 보장
// - 다중 사용자 간 sessionStorage 공유 없음

// ── 공유 타입 ──────────────────────────────────────────────────

export interface PipelineApprovalData {
  pipelineId: string;
  topicId: string;
  previousTitle: string;
  proposedTitle: string;
  rationale: string;
  outline: string[];
  strategy: StrategyPlanResult;
}

export interface PipelineResultData {
  postId: string;
  title: string;
  wordCount: number;
  evalScore: number;
  pass: boolean;
  recommendations: string[];
}

type TopicMode = "list" | "direct";

// ── 스토어 인터페이스 ──────────────────────────────────────────

interface PipelineStore {
  // 사용자 설정
  userId: string;
  topicMode: TopicMode;
  selectedTopicId: string;
  directTitle: string;
  autoApprove: boolean;

  // 실행 상태 (컴포넌트 언마운트에도 유지)
  running: boolean;
  runStartedAt: number | null; // 실행 시작 timestamp — 타이머 복원용
  stage: PipelineStage;
  events: SSEEvent[];
  streamingBody: string;
  result: PipelineResultData | null;
  inspector: InspectorState;
  runningTitle: string | null;
  approval: PipelineApprovalData | null;
  pipelineError: string | null;

  // 액션
  setUserId: (id: string) => void;
  setTopicMode: (mode: TopicMode) => void;
  setSelectedTopicId: (id: string) => void;
  setDirectTitle: (title: string) => void;
  setAutoApprove: (v: boolean) => void;
  setRunning: (v: boolean) => void;
  setRunStartedAt: (ts: number | null) => void;
  setStage: (stage: PipelineStage) => void;
  appendEvent: (event: SSEEvent) => void;
  setEvents: (events: SSEEvent[]) => void;
  appendStreamingToken: (token: string) => void;
  setStreamingBody: (body: string) => void;
  setResult: (result: PipelineResultData | null) => void;
  setInspector: (updater: InspectorState | ((prev: InspectorState) => InspectorState)) => void;
  setRunningTitle: (title: string | null) => void;
  setApproval: (a: PipelineApprovalData | null) => void;
  setPipelineError: (err: string | null) => void;
  resetRun: () => void;
}

// ── 스토어 구현 ────────────────────────────────────────────────

export const usePipelineStore = create<PipelineStore>()((set) => ({
  userId: "",
  topicMode: "list",
  selectedTopicId: "",
  directTitle: "",
  autoApprove: false,

  running: false,
  runStartedAt: null,
  stage: "idle",
  events: [],
  streamingBody: "",
  result: null,
  inspector: INITIAL_INSPECTOR_STATE,
  runningTitle: null,
  approval: null,
  pipelineError: null,

  setUserId: (id) =>
    set((s) => {
      if (s.userId === id) return { userId: id };
      // userId 변경 시 이전 실행 결과 초기화
      return {
        userId: id,
        selectedTopicId: "",
        directTitle: "",
        running: false,
        runStartedAt: null,
        stage: "idle",
        events: [],
        streamingBody: "",
        result: null,
        inspector: INITIAL_INSPECTOR_STATE,
        runningTitle: null,
        approval: null,
        pipelineError: null,
      };
    }),
  setTopicMode: (mode) => set({ topicMode: mode }),
  setSelectedTopicId: (id) => set({ selectedTopicId: id }),
  setDirectTitle: (title) => set({ directTitle: title }),
  setAutoApprove: (v) => set({ autoApprove: v }),
  setRunning: (v) => set({ running: v }),
  setRunStartedAt: (ts) => set({ runStartedAt: ts }),
  setStage: (stage) => set({ stage }),
  appendEvent: (event) => set((s) => ({ events: [...s.events, event] })),
  setEvents: (events) => set({ events }),
  appendStreamingToken: (token) => set((s) => ({ streamingBody: s.streamingBody + token })),
  setStreamingBody: (body) => set({ streamingBody: body }),
  setResult: (result) => set({ result }),
  setInspector: (updater) =>
    set((s) => ({
      inspector: typeof updater === "function" ? updater(s.inspector) : updater,
    })),
  setRunningTitle: (title) => set({ runningTitle: title }),
  setApproval: (a) => set({ approval: a }),
  setPipelineError: (err) => set({ pipelineError: err }),
  resetRun: () =>
    set({
      running: false,
      runStartedAt: null,
      stage: "idle",
      events: [],
      streamingBody: "",
      result: null,
      inspector: INITIAL_INSPECTOR_STATE,
      runningTitle: null,
      approval: null,
      pipelineError: null,
    }),
}));
