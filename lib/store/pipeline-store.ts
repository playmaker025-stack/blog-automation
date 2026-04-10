import { create } from "zustand";
import type { PipelineStage } from "@/lib/types/agent";
import type { SSEEvent } from "@/lib/agents/types";
import { INITIAL_INSPECTOR_STATE } from "@/components/pipeline/state-inspector";
import type { InspectorState } from "@/components/pipeline/state-inspector";

// 인메모리 스토어 — persist 없음
// - 탭 이동(언마운트/마운트) 후에도 상태 유지
// - F5(전체 리로드) 시 초기화 → 사용자 격리 보장
// - 다중 사용자 간 sessionStorage 공유 없음

interface ResultData {
  postId: string;
  title: string;
  wordCount: number;
  evalScore: number;
  pass: boolean;
  recommendations: string[];
}

type TopicMode = "list" | "direct";

interface PipelineStore {
  userId: string;
  topicMode: TopicMode;
  selectedTopicId: string;
  directTitle: string;
  autoApprove: boolean;

  stage: PipelineStage;
  events: SSEEvent[];
  streamingBody: string;
  result: ResultData | null;
  inspector: InspectorState;
  runningTitle: string | null;

  setUserId: (id: string) => void;
  setTopicMode: (mode: TopicMode) => void;
  setSelectedTopicId: (id: string) => void;
  setDirectTitle: (title: string) => void;
  setAutoApprove: (v: boolean) => void;
  setStage: (stage: PipelineStage) => void;
  appendEvent: (event: SSEEvent) => void;
  setEvents: (events: SSEEvent[]) => void;
  appendStreamingToken: (token: string) => void;
  setStreamingBody: (body: string) => void;
  setResult: (result: ResultData | null) => void;
  setInspector: (updater: InspectorState | ((prev: InspectorState) => InspectorState)) => void;
  setRunningTitle: (title: string | null) => void;
  resetRun: () => void;
}

export const usePipelineStore = create<PipelineStore>()((set) => ({
  userId: "",
  topicMode: "list",
  selectedTopicId: "",
  directTitle: "",
  autoApprove: false,

  stage: "idle",
  events: [],
  streamingBody: "",
  result: null,
  inspector: INITIAL_INSPECTOR_STATE,
  runningTitle: null,

  setUserId: (id) =>
    set((s) => {
      // userId가 바뀌면 이전 사용자의 실행 결과 초기화
      if (s.userId === id) return { userId: id };
      return {
        userId: id,
        selectedTopicId: "",
        directTitle: "",
        stage: "idle",
        events: [],
        streamingBody: "",
        result: null,
        inspector: INITIAL_INSPECTOR_STATE,
        runningTitle: null,
      };
    }),
  setTopicMode: (mode) => set({ topicMode: mode }),
  setSelectedTopicId: (id) => set({ selectedTopicId: id }),
  setDirectTitle: (title) => set({ directTitle: title }),
  setAutoApprove: (v) => set({ autoApprove: v }),
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
  resetRun: () =>
    set({
      stage: "idle",
      events: [],
      streamingBody: "",
      result: null,
      inspector: INITIAL_INSPECTOR_STATE,
      runningTitle: null,
    }),
}));
