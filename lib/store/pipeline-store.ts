import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { PipelineStage } from "@/lib/types/agent";
import type { SSEEvent, StrategyPlanResult } from "@/lib/agents/types";
import { INITIAL_INSPECTOR_STATE } from "@/components/pipeline/state-inspector";
import type { InspectorState } from "@/components/pipeline/state-inspector";

// 인메모리 + sessionStorage persist 스토어
// - 탭 이동(언마운트/마운트) 후에도 상태 유지
// - F5(전체 리로드) 시에도 sessionStorage에서 복원 → 탭 닫을 때까지 유지
// - 다중 사용자: 각 브라우저 탭은 독립적인 sessionStorage를 가짐

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

// BatchItemStatus — pipeline-runner에서도 사용 (여기서 정의 후 re-export)
export interface BatchItemStatus {
  topicId: string;
  title: string;
  status: "pending" | "running" | "done" | "failed";
  evalScore?: number;
  wordCount?: number;
  pass?: boolean;
}

type TopicMode = "list" | "direct";
type ExecMode = "single" | "batch";

// ── 스토어 인터페이스 ──────────────────────────────────────────

interface PipelineStore {
  // 사용자 설정
  userId: string;
  topicMode: TopicMode;
  selectedTopicId: string;
  directTitle: string;
  autoApprove: boolean;

  // 실행 모드 & 배치 상태 (이전 로컬 state → Zustand로 이동)
  execMode: ExecMode;
  batchSelectedIds: string[]; // Set<string>을 string[]로 저장 (JSON 직렬화)
  batchRunning: boolean;
  batchQueue: BatchItemStatus[];

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
  setExecMode: (mode: ExecMode) => void;
  setBatchSelectedIds: (ids: string[]) => void;
  toggleBatchItem: (id: string) => void;
  setBatchRunning: (v: boolean) => void;
  setBatchQueue: (queue: BatchItemStatus[]) => void;
  updateBatchItem: (idx: number, update: Partial<BatchItemStatus>) => void;
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

// ── SSR 안전 sessionStorage ────────────────────────────────────

const safeSessionStorage = () => {
  if (typeof window === "undefined") {
    // SSR: 인메모리 fallback (서버에서는 persist 미적용)
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value); },
      removeItem: (key: string) => { map.delete(key); },
    };
  }
  return sessionStorage;
};

// ── 스토어 구현 ────────────────────────────────────────────────

export const usePipelineStore = create<PipelineStore>()(
  persist(
    (set) => ({
      userId: "",
      topicMode: "list",
      selectedTopicId: "",
      directTitle: "",
      autoApprove: false,

      execMode: "single",
      batchSelectedIds: [],
      batchRunning: false,
      batchQueue: [],

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
          if (s.userId === id) return s;
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
            batchSelectedIds: [],
            batchRunning: false,
            batchQueue: [],
          };
        }),
      setTopicMode: (mode) => set({ topicMode: mode }),
      setSelectedTopicId: (id) => set({ selectedTopicId: id }),
      setDirectTitle: (title) => set({ directTitle: title }),
      setAutoApprove: (v) => set({ autoApprove: v }),
      setExecMode: (mode) => set({ execMode: mode }),
      setBatchSelectedIds: (ids) => set({ batchSelectedIds: ids }),
      toggleBatchItem: (id) =>
        set((s) => {
          const ids = s.batchSelectedIds;
          if (ids.includes(id)) return { batchSelectedIds: ids.filter((x) => x !== id) };
          return { batchSelectedIds: [...ids, id] };
        }),
      setBatchRunning: (v) => set({ batchRunning: v }),
      setBatchQueue: (queue) => set({ batchQueue: queue }),
      updateBatchItem: (idx, update) =>
        set((s) => ({
          batchQueue: s.batchQueue.map((item, i) => (i === idx ? { ...item, ...update } : item)),
        })),
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
    }),
    {
      name: "pipeline-store-v1",
      storage: createJSONStorage(safeSessionStorage),
    }
  )
);
