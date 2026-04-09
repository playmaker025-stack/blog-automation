"use client";

import { useState } from "react";
import type { ApprovalRequest } from "@/lib/agents/types";

interface Props {
  pipelineId: string;
  previousTitle: string;
  proposedTitle: string;
  rationale: string;
  outline: string[];
  onApprove: (req: ApprovalRequest) => Promise<void>;
  onReject: () => void;
}

export function ApprovalDialog({
  pipelineId,
  previousTitle,
  proposedTitle,
  rationale,
  outline,
  onApprove,
  onReject: _onReject,
}: Props) {
  const [modifications, setModifications] = useState("");
  const [loading, setLoading] = useState(false);

  const handleApprove = async () => {
    setLoading(true);
    try {
      await onApprove({ pipelineId, approved: true });
    } finally {
      setLoading(false);
    }
  };

  const handleReject = async () => {
    setLoading(true);
    try {
      await onApprove({ pipelineId, approved: false, modifications });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg border-2 border-amber-400">

        {/* 승인 대기 배너 */}
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-3 rounded-t-xl flex items-center gap-2">
          <span className="inline-block w-2.5 h-2.5 rounded-full bg-amber-400 animate-pulse" />
          <p className="text-sm font-semibold text-amber-700">승인 대기 중 — 전략 확인 후 승인해주세요</p>
        </div>

        <div className="px-6 py-5 border-b border-zinc-100">
          <h2 className="text-lg font-semibold text-zinc-900">전략 승인 요청</h2>
          <p className="text-sm text-zinc-500 mt-1">
            아래 전략을 확인하고 승인하면 Master Writer가 본문 작성을 시작합니다.
          </p>
        </div>

        <div className="px-6 py-5 space-y-4">
          {previousTitle !== proposedTitle && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
              <p className="text-xs text-amber-700 font-medium mb-1">제목 변경</p>
              <p className="text-sm text-zinc-500 line-through">{previousTitle}</p>
              <p className="text-sm text-zinc-900 font-medium mt-0.5">{proposedTitle}</p>
            </div>
          )}

          <div>
            <p className="text-xs text-zinc-500 font-medium mb-1">제안 제목</p>
            <p className="text-sm font-semibold text-zinc-900">{proposedTitle}</p>
          </div>

          <div>
            <p className="text-xs text-zinc-500 font-medium mb-1">전략 근거</p>
            <ol className="space-y-1">
              {rationale
                .split(/(?=[①②③④⑤⑥⑦⑧⑨⑩])|(?=\d+\.\s)|\n/)
                .map((s) => s.trim())
                .filter(Boolean)
                .map((item, i) => (
                  <li key={i} className="text-sm text-zinc-700">{item}</li>
                ))}
            </ol>
          </div>

          {outline.length > 0 && (
            <div>
              <p className="text-xs text-zinc-500 font-medium mb-1">아웃라인</p>
              <ol className="list-decimal list-inside space-y-1">
                {outline.map((h, i) => (
                  <li key={i} className="text-sm text-zinc-700">{h}</li>
                ))}
              </ol>
            </div>
          )}

          <div>
            <p className="text-xs text-zinc-500 font-medium mb-1">거절 시 수정 요청 (선택)</p>
            <textarea
              value={modifications}
              onChange={(e) => setModifications(e.target.value)}
              placeholder="제목이나 방향에 대한 수정 요청을 입력하세요..."
              rows={2}
              className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm text-zinc-900 resize-none focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        <div className="px-6 py-4 border-t border-zinc-100 flex justify-end gap-3">
          <button
            onClick={handleReject}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-zinc-700 bg-zinc-100 rounded-lg hover:bg-zinc-200 disabled:opacity-50 transition-colors"
          >
            거절
          </button>
          <button
            onClick={handleApprove}
            disabled={loading}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {loading ? "처리 중..." : "✓ 승인하고 작성 시작"}
          </button>
        </div>
      </div>
    </div>
  );
}
