/**
 * TopicsStore — 글목록 페이지 상태 싱글턴
 *
 * AI 글목록 생성, 불러오기 프리뷰 등 페이지 이탈 후에도
 * 유지되어야 하는 상태를 관리한다.
 */

import { create } from "zustand";
import type { TopicGeneratorOutput } from "@/lib/agents/topic-generator";

interface TopicsStore {
  // AI 글목록 생성
  generateUserId: string;
  generating: boolean;
  generateResult: TopicGeneratorOutput | null;
  selectedGenerated: Set<number>;
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
  setSelectedGenerated: (s: Set<number>) => void;
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

export const useTopicsStore = create<TopicsStore>()((set) => ({
  generateUserId: "",
  generating: false,
  generateResult: null,
  selectedGenerated: new Set(),
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
  setSelectedGenerated: (s) => set({ selectedGenerated: s }),
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
    set({ generateResult: null, selectedGenerated: new Set() }),
}));
