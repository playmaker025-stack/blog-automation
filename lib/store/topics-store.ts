/**
 * TopicsStore — 글목록 페이지 상태 싱글턴
 *
 * AI 글목록 생성, 불러오기 프리뷰 등 페이지 이탈 후에도
 * 유지되어야 하는 상태를 관리한다.
 * sessionStorage persist로 F5 리로드 후에도 복원됨.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { TopicGeneratorOutput } from "@/lib/agents/topic-generator";

interface TopicsStore {
  // AI 글목록 생성
  generateUserId: string;
  generating: boolean;
  generateResult: TopicGeneratorOutput | null;
  selectedGeneratedIndices: number[]; // Set<number> → number[] (JSON 직렬화)
  savingGenerated: boolean;

  // 불러오기 패널 (텍스트/파일)
  importTab: "text" | "file";
  pasteText: string;
  preview: Array<{ title: string; blog: string }>;
  parsedCount: number;
  duplicateCount: number;
  failedCount: number;

  // 알림
  notice: { type: "ok" | "err"; msg: string } | null;

  // 액션
  setGenerateUserId: (id: string) => void;
  setGenerating: (v: boolean) => void;
  setGenerateResult: (r: TopicGeneratorOutput | null) => void;
  setSelectedGeneratedIndices: (indices: number[]) => void;
  toggleSelectedGenerated: (idx: number) => void;
  setSavingGenerated: (v: boolean) => void;
  setImportTab: (tab: "text" | "file") => void;
  setPasteText: (text: string) => void;
  setPreview: (items: Array<{ title: string; blog: string }>) => void;
  setParsedCount: (n: number) => void;
  setDuplicateCount: (n: number) => void;
  setFailedCount: (n: number) => void;
  setNotice: (n: { type: "ok" | "err"; msg: string } | null) => void;
  clearImport: () => void;
  clearGenerate: () => void;
}

const safeSessionStorage = () => {
  if (typeof window === "undefined") {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, value); },
      removeItem: (key: string) => { map.delete(key); },
    };
  }
  return sessionStorage;
};

export const useTopicsStore = create<TopicsStore>()(
  persist(
    (set) => ({
      generateUserId: "",
      generating: false,
      generateResult: null,
      selectedGeneratedIndices: [],
      savingGenerated: false,

      importTab: "text",
      pasteText: "",
      preview: [],
      parsedCount: 0,
      duplicateCount: 0,
      failedCount: 0,

      notice: null,

      setGenerateUserId: (id) => set({ generateUserId: id }),
      setGenerating: (v) => set({ generating: v }),
      setGenerateResult: (r) => set({ generateResult: r }),
      setSelectedGeneratedIndices: (indices) => set({ selectedGeneratedIndices: indices }),
      toggleSelectedGenerated: (idx) =>
        set((s) => {
          const arr = s.selectedGeneratedIndices;
          if (arr.includes(idx)) return { selectedGeneratedIndices: arr.filter((i) => i !== idx) };
          return { selectedGeneratedIndices: [...arr, idx] };
        }),
      setSavingGenerated: (v) => set({ savingGenerated: v }),
      setImportTab: (tab) => set({ importTab: tab }),
      setPasteText: (text) => set({ pasteText: text }),
      setPreview: (items) => set({ preview: items }),
      setParsedCount: (n) => set({ parsedCount: n }),
      setDuplicateCount: (n) => set({ duplicateCount: n }),
      setFailedCount: (n) => set({ failedCount: n }),
      setNotice: (n) => set({ notice: n }),
      clearImport: () =>
        set({ pasteText: "", preview: [], parsedCount: 0, duplicateCount: 0, failedCount: 0 }),
      clearGenerate: () =>
        set({ generateResult: null, selectedGeneratedIndices: [] }),
    }),
    {
      name: "topics-store-v1",
      storage: createJSONStorage(safeSessionStorage),
    }
  )
);
