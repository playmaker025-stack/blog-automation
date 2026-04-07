"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Topic, PostingRecord } from "@/lib/types/github-data";

export default function DashboardPage() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [posts, setPosts] = useState<PostingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const loadData = useCallback(() => {
    const t = Date.now();
    setLoading(true);
    setError(null);
    Promise.all([
      fetch(`/api/github/topics?_t=${t}`).then((r) => r.json()),
      fetch(`/api/github/posts?limit=5&_t=${t}`).then((r) => r.json()),
    ])
      .then(([topicData, postData]) => {
        setTopics((topicData as { topics: Topic[] }).topics ?? []);
        setPosts((postData as { posts: PostingRecord[] }).posts ?? []);
        setLastUpdated(new Date());
      })
      .catch(() => setError("데이터를 불러오지 못했습니다. 새로고침을 시도해 주세요."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const statusCounts = {
    draft: topics.filter((t) => t.status === "draft").length,
    planned: topics.filter((t) => t.status === "planned").length,
    "in-progress": topics.filter((t) => t.status === "in-progress").length,
    published: topics.filter((t) => t.status === "published").length,
  };

  const publishedPosts = posts.filter((p) => p.status === "published");
  const avgEval =
    publishedPosts.length > 0
      ? Math.round(
          publishedPosts.reduce((acc, p) => acc + (p.evalScore ?? 0), 0) /
            publishedPosts.length
        )
      : null;

  return (
    <div className="p-8 max-w-5xl">
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">대시보드</h1>
          <p className="text-zinc-500 mt-1 text-sm">네이버 블로그 자동화 현황</p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && !loading && (
            <span className="text-xs text-zinc-400">
              {lastUpdated.toLocaleTimeString("ko-KR")} 기준
            </span>
          )}
          <button
            onClick={loadData}
            disabled={loading}
            className="px-3 py-1.5 text-xs font-medium bg-white border border-zinc-200 rounded-lg hover:bg-zinc-50 disabled:opacity-50 transition-colors"
          >
            {loading ? "로딩 중..." : "새로고침"}
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 bg-red-50 border border-red-200 rounded-xl p-4 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* 통계 카드 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
        {[
          { label: "전체 토픽", value: loading ? "-" : topics.length, color: "text-zinc-900" },
          { label: "진행 중", value: loading ? "-" : statusCounts["in-progress"], color: "text-blue-600" },
          { label: "발행 완료", value: loading ? "-" : statusCounts.published, color: "text-emerald-600" },
          {
            label: "평균 Eval",
            value: loading ? "-" : avgEval !== null ? `${avgEval}점` : "-",
            color: avgEval !== null && avgEval >= 70 ? "text-emerald-600" : "text-zinc-500",
          },
        ].map((stat) => (
          <div key={stat.label} className="bg-white border border-zinc-200 rounded-xl p-5">
            <p className="text-xs text-zinc-500">{stat.label}</p>
            <p className={`text-3xl font-bold mt-1 ${stat.color}`}>{stat.value}</p>
          </div>
        ))}
      </div>

      {/* 토픽 상태 분포 */}
      <div className="bg-white border border-zinc-200 rounded-xl p-5 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-zinc-700">토픽 상태</h2>
          <Link href="/topics" className="text-xs text-blue-600 hover:underline">
            전체 보기
          </Link>
        </div>
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: "초안", count: statusCounts.draft, color: "bg-zinc-100" },
            { label: "계획됨", count: statusCounts.planned, color: "bg-blue-50" },
            { label: "진행 중", count: statusCounts["in-progress"], color: "bg-amber-50" },
            { label: "발행됨", count: statusCounts.published, color: "bg-emerald-50" },
          ].map((s) => (
            <div key={s.label} className={`${s.color} rounded-lg p-3 text-center`}>
              <p className="text-2xl font-bold text-zinc-800">{loading ? "-" : s.count}</p>
              <p className="text-xs text-zinc-500 mt-0.5">{s.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* 최근 포스팅 */}
      <div className="bg-white border border-zinc-200 rounded-xl p-5">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-zinc-700">최근 포스팅</h2>
          <Link href="/posts" className="text-xs text-blue-600 hover:underline">
            전체 보기
          </Link>
        </div>
        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 bg-zinc-100 rounded animate-pulse" />
            ))}
          </div>
        ) : posts.length === 0 ? (
          <p className="text-sm text-zinc-400 text-center py-6">
            아직 포스팅이 없습니다.{" "}
            <Link href="/pipeline" className="text-blue-600 hover:underline">
              파이프라인을 실행
            </Link>
            해보세요.
          </p>
        ) : (
          <div className="space-y-2">
            {posts.map((post) => (
              <div
                key={post.postId}
                className="flex items-center justify-between py-2 border-b border-zinc-50 last:border-0"
              >
                <div>
                  <p className="text-sm font-medium text-zinc-800">{post.title}</p>
                  <p className="text-xs text-zinc-400">
                    {post.userId} · {new Date(post.createdAt).toLocaleDateString("ko-KR")}
                  </p>
                </div>
                {post.evalScore !== null && (
                  <span
                    className={`text-sm font-bold ${
                      post.evalScore >= 70 ? "text-emerald-600" : "text-red-500"
                    }`}
                  >
                    {post.evalScore}점
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
