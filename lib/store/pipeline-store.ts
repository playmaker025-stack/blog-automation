import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { PipelineStage } from "@/lib/types/agent";
import type { SSEEvent, EvalResult } from "@/lib/agents/types";
import { INITIAL_INSPECTOR_STATE } from "@/components/pipeline/state-inspector";
import type { InspectorState } from "@/components/pipeline/state-inspector";

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
  // 입력 설정 (페이지 이탈 후 복원)
  userId: string;
  topicMode: TopicMode;
  selectedTopicId: string;
  directTitle: string;
  autoApprove: boolean;

  // 실행 결과 (페이지 이탈 후 복원)
  stage: PipelineStage;
  events: SSEEvent[];
  streamingBody: string;
  result: ResultData | null;
  evalScores: EvalResult["scores"] | null;
  inspector: InspectorState;
  runningTitle: string | null;

  // Actions
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
  setEvalScores: (scores: EvalResult["scores"] | null) => void;
  setInspector: (updater: InspectorState | ((prev: InspectorState) => InspectorState)) => void;
  setRunningTitle: (title: string | null) => void;
  resetRun: () => void;
}

export const usePipelineStore = create<PipelineStore>()(
  persist(
    (set) => ({
      userId: "",
      topicMode: "list",
      selectedTopicId: "",
      directTitle: "",
      autoApprove: false,

      stage: "idle",
      events: [],
      streamingBody: "",
      result: null,
      evalScores: null,
      inspector: INITIAL_INSPECTOR_STATE,
      runningTitle: null,

      setUserId: (id) => set({ userId: id }),
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
      setEvalScores: (evalScores) => set({ evalScores }),
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
          evalScores: null,
          inspector: INITIAL_INSPECTOR_STATE,
          runningTitle: null,
        }),
    }),
    {
      name: "pipeline-store",
      storage: createJSONStorage(() => sessionStorage),
      // running/approval/elapsed은 로컬 상태로 유지 — 세션에 저장 안 함
      partialize: (s) => ({
        userId: s.userId,
        topicMode: s.topicMode,
        selectedTopicId: s.selectedTopicId,
        directTitle: s.directTitle,
        autoApprove: s.autoApprove,
        stage: s.stage,
        events: s.events,
        streamingBody: s.streamingBody,
        result: s.result,
        evalScores: s.evalScores,
        inspector: s.inspector,
        runningTitle: s.runningTitle,
      }),
    }
  )
);
