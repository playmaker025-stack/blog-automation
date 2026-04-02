"use client";

import { useState } from "react";
import type { Topic } from "@/lib/types/github-data";

type TopicFormData = Pick<
  Topic,
  "title" | "description" | "category" | "tags" | "relatedSources" | "assignedUserId"
>;

interface Props {
  mode: "create" | "edit";
  initialData?: Partial<TopicFormData>;
  onSubmit: (data: TopicFormData) => Promise<void>;
  onCancel: () => void;
}

export function TopicForm({ mode, initialData, onSubmit, onCancel }: Props) {
  const [title, setTitle] = useState(initialData?.title ?? "");
  const [description, setDescription] = useState(initialData?.description ?? "");
  const [category, setCategory] = useState(initialData?.category ?? "일반");
  const [tagsInput, setTagsInput] = useState(initialData?.tags?.join(", ") ?? "");
  const [sourcesInput, setSourcesInput] = useState(
    initialData?.relatedSources?.join("\n") ?? ""
  );
  const [userId, setUserId] = useState(initialData?.assignedUserId ?? "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError("제목을 입력해주세요.");
      return;
    }
    setError("");
    setLoading(true);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim(),
        category: category.trim() || "일반",
        tags: tagsInput.split(",").map((t) => t.trim()).filter(Boolean),
        relatedSources: sourcesInput.split("\n").map((s) => s.trim()).filter(Boolean),
        assignedUserId: userId.trim() || null,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-zinc-700 mb-1">
          제목 <span className="text-red-500">*</span>
        </label>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="포스팅 토픽 제목"
          className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-700 mb-1">설명</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="토픽 설명"
          rows={2}
          className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">카테고리</label>
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="여행, 음식, 일상..."
            className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1">담당 사용자 ID</label>
          <input
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            placeholder="example-user"
            className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-700 mb-1">
          태그 <span className="text-zinc-400 text-xs">(쉼표로 구분)</span>
        </label>
        <input
          value={tagsInput}
          onChange={(e) => setTagsInput(e.target.value)}
          placeholder="서울, 카페, 주말나들이"
          className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-zinc-700 mb-1">
          참조 URL <span className="text-zinc-400 text-xs">(한 줄에 하나)</span>
        </label>
        <textarea
          value={sourcesInput}
          onChange={(e) => setSourcesInput(e.target.value)}
          placeholder="https://..."
          rows={2}
          className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      <div className="flex justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm text-zinc-700 bg-zinc-100 rounded-lg hover:bg-zinc-200 transition-colors"
        >
          취소
        </button>
        <button
          type="submit"
          disabled={loading}
          className="px-4 py-2 text-sm text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {loading ? "저장 중..." : mode === "create" ? "토픽 추가" : "저장"}
        </button>
      </div>
    </form>
  );
}
