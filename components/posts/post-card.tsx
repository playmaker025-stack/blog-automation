import type { PostingRecord } from "@/lib/types/github-data";

const STATUS_LABEL: Record<PostingRecord["status"], { label: string; color: string }> = {
  draft:            { label: "초안",     color: "bg-zinc-100 text-zinc-600" },
  ready:            { label: "검토 중",  color: "bg-blue-100 text-blue-700" },
  approved:         { label: "승인됨",   color: "bg-emerald-100 text-emerald-700" },
  audit_failed:     { label: "평가 미달", color: "bg-amber-100 text-amber-700" },
  published:        { label: "발행 완료", color: "bg-green-100 text-green-700" },
  failed:           { label: "실패",     color: "bg-red-100 text-red-700" },
};

interface Props {
  post: PostingRecord;
  onApprove?: (postId: string) => void;
}

export function PostCard({ post, onApprove }: Props) {
  const { label, color } = STATUS_LABEL[post.status];
  const scoreColor =
    post.evalScore === null
      ? "text-zinc-400"
      : post.evalScore >= 80
      ? "text-emerald-600"
      : post.evalScore >= 70
      ? "text-amber-600"
      : "text-red-600";

  return (
    <div className="bg-white border border-zinc-200 rounded-xl p-4 hover:shadow-sm transition-shadow">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-semibold text-zinc-900 truncate">{post.title}</h3>
          <p className="text-xs text-zinc-400 mt-0.5">
            {post.userId} · {new Date(post.createdAt).toLocaleDateString("ko-KR")}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {post.evalScore !== null && (
            <span className={`text-sm font-bold ${scoreColor}`}>{post.evalScore}점</span>
          )}
          <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${color}`}>
            {label}
          </span>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <div className="flex gap-3 text-xs text-zinc-400">
          <span>{post.wordCount.toLocaleString()}자</span>
          {post.publishedAt && (
            <span>발행: {new Date(post.publishedAt).toLocaleDateString("ko-KR")}</span>
          )}
        </div>
        <div className="flex gap-2">
          {post.naverPostUrl && (
            <a
              href={post.naverPostUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-blue-600 hover:underline"
            >
              블로그 보기
            </a>
          )}
          {post.status === "ready" && onApprove && (
            <button
              onClick={() => onApprove(post.postId)}
              className="text-xs bg-emerald-600 text-white px-2 py-1 rounded hover:bg-emerald-700 transition-colors"
            >
              발행 승인
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
