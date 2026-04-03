"use client";

import { useEffect, useRef, useState } from "react";
import type { PostingRecord } from "@/lib/types/github-data";
import { parseIndexText, readFileAutoEncoding } from "@/lib/skills/import-parser";

type StatusFilter = "all" | PostingRecord["status"];

const STATUS_LABELS: Record<PostingRecord["status"], string> = {
  draft: "초안",
  ready: "검토 중",
  approved: "승인됨",
  audit_failed: "평가 미달",
  published: "발행 완료",
  failed: "실패",
};

const STATUS_COLORS: Record<PostingRecord["status"], string> = {
  draft: "bg-zinc-100 text-zinc-600",
  ready: "bg-sky-100 text-sky-700",
  approved: "bg-blue-100 text-blue-700",
  audit_failed: "bg-amber-100 text-amber-700",
  published: "bg-emerald-100 text-emerald-700",
  failed: "bg-red-100 text-red-600",
};

const FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "draft", label: "초안" },
  { value: "ready", label: "검토 중" },
  { value: "approved", label: "승인됨" },
  { value: "published", label: "발행 완료" },
  { value: "audit_failed", label: "평가 미달" },
  { value: "failed", label: "실패" },
];

interface EditState {
  postId: string;
  title: string;
  naverPostUrl: string;
  status: PostingRecord["status"];
}

// ── 블로그 배지 색상 ────────────────────────────────────────
const BLOG_BADGE_COLORS: Record<string, string> = {
  A: "bg-blue-100 text-blue-700",
  B: "bg-violet-100 text-violet-700",
  C: "bg-emerald-100 text-emerald-700",
  D: "bg-orange-100 text-orange-700",
  E: "bg-pink-100 text-pink-700",
};

export default function PostsPage() {
  const [posts, setPosts] = useState<PostingRecord[]>([]);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [loading, setLoading] = useState(true);

  // 항목 추가 모달
  const [showAdd, setShowAdd] = useState(false);
  const [addTitle, setAddTitle] = useState("");
  const [addUrl, setAddUrl] = useState("");
  const [addUserId, setAddUserId] = useState("");

  // 항목 수정 인라인
  const [editing, setEditing] = useState<EditState | null>(null);

  // TXT 가져오기
  const [showImport, setShowImport] = useState(false);
  const [importTab, setImportTab] = useState<"text" | "file">("text");
  const [importText, setImportText] = useState("");
  const [importPreview, setImportPreview] = useState<Array<{ title: string; url: string; blog: string }>>([]);
  const [parsedCount, setParsedCount] = useState(0);
  const [duplicateCount, setDuplicateCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const [importing, setSaving] = useState(false);

  const [notice, setNotice] = useState<{ type: "ok" | "err"; msg: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = () => {
    setLoading(true);
    fetch(`/api/github/posts?limit=100&_t=${Date.now()}`)
      .then((r) => r.json())
      .then((d: { posts: PostingRecord[] }) => setPosts(d.posts ?? []))
      .catch(() => setNotice({ type: "err", msg: "목록 로드 실패" }))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const filtered = filter === "all" ? posts : posts.filter((p) => p.status === filter);

  // ── 항목 추가 ──────────────────────────────────────────────
  const handleAdd = async () => {
    if (!addTitle.trim() || !addUserId.trim()) return;
    try {
      const res = await fetch("/api/github/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          postId: `post-manual-${Date.now().toString(36)}`,
          topicId: "",
          userId: addUserId.trim(),
          title: addTitle.trim(),
          status: "published",
          naverPostUrl: addUrl.trim() || null,
          wordCount: 0,
        }),
      });
      if (!res.ok) throw new Error();
      setShowAdd(false);
      setAddTitle("");
      setAddUrl("");
      setAddUserId("");
      setNotice({ type: "ok", msg: "항목이 추가되었습니다." });
      load();
    } catch {
      setNotice({ type: "err", msg: "추가 실패" });
    }
  };

  // ── 항목 수정 ──────────────────────────────────────────────
  const startEdit = (post: PostingRecord) => {
    setEditing({
      postId: post.postId,
      title: post.title,
      naverPostUrl: post.naverPostUrl ?? "",
      status: post.status,
    });
    setNotice(null);
  };

  const handleSaveEdit = async () => {
    if (!editing) return;
    try {
      const res = await fetch("/api/github/posts", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          postId: editing.postId,
          title: editing.title,
          naverPostUrl: editing.naverPostUrl || null,
          status: editing.status,
        }),
      });
      if (!res.ok) throw new Error();
      setEditing(null);
      setNotice({ type: "ok", msg: "수정되었습니다." });
      load();
    } catch {
      setNotice({ type: "err", msg: "수정 실패" });
    }
  };

  // ── 항목 삭제 ──────────────────────────────────────────────
  const handleDelete = async (postId: string, title: string) => {
    if (!confirm(`"${title}" 항목을 삭제하시겠습니까?`)) return;
    try {
      const res = await fetch(`/api/github/posts?postId=${postId}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      setNotice({ type: "ok", msg: "삭제되었습니다." });
      load();
    } catch {
      setNotice({ type: "err", msg: "삭제 실패" });
    }
  };

  // ── TXT 가져오기 ───────────────────────────────────────────
  const applyImportText = (text: string) => {
    setImportText(text);
    const result = parseIndexText(text);
    setImportPreview(result.items);
    setParsedCount(result.parsed_count);
    setDuplicateCount(result.duplicate_count);
    setFailedCount(result.failed_count);
    setNotice(null);
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await readFileAutoEncoding(file);
    applyImportText(text);
  };

  const handleBulkAdd = async () => {
    if (importPreview.length === 0) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/github/posts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          records: importPreview.map(({ title, url, blog }) => ({ title, url, blog })),
        }),
      });
      const json = await res.json() as { added?: number; duplicates?: number; error?: string };
      if (!res.ok) throw new Error(json.error ?? "일괄 가져오기 실패");
      setShowImport(false);
      setImportText("");
      setImportPreview([]);
      setParsedCount(0); setDuplicateCount(0); setFailedCount(0);
      const parts = [`추가 ${json.added ?? 0}건`];
      if (json.duplicates) parts.push(`중복 제외 ${json.duplicates}건`);
      if (failedCount > 0) parts.push(`실패 ${failedCount}건`);
      setNotice({ type: "ok", msg: parts.join(" / ") });
      load();
    } catch (e) {
      setNotice({ type: "err", msg: e instanceof Error ? e.message : "추가 실패" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="p-8 max-w-4xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">발행 인덱스</h1>
          <p className="text-zinc-500 mt-1 text-sm">총 {posts.length}개 포스팅</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => { setShowImport(true); setNotice(null); }}
            className="px-3 py-2 border border-zinc-200 text-zinc-600 text-sm font-medium rounded-lg hover:bg-zinc-50 transition-colors"
          >
            TXT 가져오기
          </button>
          <button
            onClick={() => { setShowAdd(true); setNotice(null); }}
            className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors"
          >
            + 항목 추가
          </button>
        </div>
      </div>

      {notice && (
        <p className={`text-sm mb-4 ${notice.type === "ok" ? "text-emerald-600" : "text-red-500"}`}>
          {notice.msg}
        </p>
      )}

      <div className="flex gap-2 mb-5 flex-wrap">
        {FILTERS.map(({ value, label }) => {
          const count = value === "all" ? posts.length : posts.filter((p) => p.status === value).length;
          return (
            <button
              key={value}
              onClick={() => setFilter(value)}
              className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${
                filter === value
                  ? "bg-zinc-900 text-white"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
              }`}
            >
              {label} ({count})
            </button>
          );
        })}
      </div>

      {loading ? (
        <p className="text-zinc-400 text-sm">로딩 중...</p>
      ) : filtered.length === 0 ? (
        <p className="text-zinc-400 text-sm text-center py-16">포스팅이 없습니다.</p>
      ) : (
        <div className="space-y-2">
          {filtered.map((post) => (
            <div key={post.postId}>
              {editing?.postId === post.postId ? (
                // 인라인 수정 폼
                <div className="bg-white border-2 border-blue-300 rounded-xl p-4">
                  <div className="grid grid-cols-1 gap-3 mb-3">
                    <div>
                      <label className="block text-xs text-zinc-500 mb-1">제목</label>
                      <input
                        value={editing.title}
                        onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                        className="w-full border border-zinc-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-zinc-500 mb-1">네이버 포스팅 URL</label>
                      <input
                        value={editing.naverPostUrl}
                        onChange={(e) => setEditing({ ...editing, naverPostUrl: e.target.value })}
                        placeholder="https://blog.naver.com/..."
                        className="w-full border border-zinc-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-zinc-500 mb-1">상태</label>
                      <select
                        value={editing.status}
                        onChange={(e) => setEditing({ ...editing, status: e.target.value as PostingRecord["status"] })}
                        className="border border-zinc-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      >
                        {Object.entries(STATUS_LABELS).map(([v, l]) => (
                          <option key={v} value={v}>{l}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => setEditing(null)}
                      className="px-3 py-1.5 text-xs text-zinc-600 hover:text-zinc-900"
                    >
                      취소
                    </button>
                    <button
                      onClick={handleSaveEdit}
                      className="px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded-lg hover:bg-blue-700"
                    >
                      저장
                    </button>
                  </div>
                </div>
              ) : (
                // 일반 행
                <div className="bg-white border border-zinc-200 rounded-xl px-4 py-3 flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-zinc-900 truncate">{post.title}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-zinc-400">{post.userId}</span>
                      {post.naverPostUrl && (
                        <a
                          href={post.naverPostUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-blue-500 hover:underline truncate max-w-xs"
                        >
                          {post.naverPostUrl}
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {post.evalScore != null && (
                      <span className="text-xs text-zinc-400">{post.evalScore}점</span>
                    )}
                    <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${STATUS_COLORS[post.status]}`}>
                      {STATUS_LABELS[post.status]}
                    </span>
                    <button
                      onClick={() => startEdit(post)}
                      className="text-xs text-zinc-400 hover:text-zinc-700 px-1"
                    >
                      수정
                    </button>
                    <button
                      onClick={() => handleDelete(post.postId, post.title)}
                      className="text-xs text-zinc-400 hover:text-red-500 px-1"
                    >
                      삭제
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ── 항목 추가 모달 ─────────────────────────────────── */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6">
            <h2 className="text-base font-semibold text-zinc-900 mb-4">인덱스 항목 추가</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">글제목 *</label>
                <input
                  value={addTitle}
                  onChange={(e) => setAddTitle(e.target.value)}
                  placeholder="글제목을 입력하세요"
                  className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">사용자 ID *</label>
                <input
                  value={addUserId}
                  onChange={(e) => setAddUserId(e.target.value)}
                  placeholder="사용자 ID"
                  className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">네이버 포스팅 URL</label>
                <input
                  value={addUrl}
                  onChange={(e) => setAddUrl(e.target.value)}
                  placeholder="https://blog.naver.com/..."
                  className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => { setShowAdd(false); setAddTitle(""); setAddUrl(""); setAddUserId(""); }}
                className="px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900"
              >
                취소
              </button>
              <button
                onClick={handleAdd}
                disabled={!addTitle.trim() || !addUserId.trim()}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                추가
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── TXT 가져오기 모달 ──────────────────────────────── */}
      {showImport && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6">
            <h2 className="text-base font-semibold text-zinc-900 mb-1">TXT 가져오기</h2>
            <p className="text-xs text-zinc-400 mb-4">
              지원 형식: <code className="bg-zinc-100 px-1 rounded">No[탭]블로그[탭]날짜[탭]제목[탭]URL...</code> (7컬럼 TSV),{" "}
              <code className="bg-zinc-100 px-1 rounded">제목|URL</code>, 또는 제목만
            </p>

            {/* 탭 선택 */}
            <div className="flex gap-1.5 mb-4">
              {(["text", "file"] as const).map((tab) => (
                <button key={tab} onClick={() => setImportTab(tab)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-full transition-colors ${importTab === tab ? "bg-zinc-900 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"}`}>
                  {tab === "text" ? "텍스트 붙여넣기" : "파일 업로드"}
                </button>
              ))}
            </div>

            {importTab === "text" ? (
              <textarea
                value={importText}
                onChange={(e) => applyImportText(e.target.value)}
                placeholder={"1\tA\t2026-02-26\t전자담배 기기 버블몬...\thttps://blog.naver.com/...\t키워드\t검색어\n또는: 글제목 | https://..."}
                rows={6}
                className="w-full border border-zinc-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none font-mono"
              />
            ) : (
              <div onClick={() => fileRef.current?.click()}
                className="border-2 border-dashed border-zinc-200 rounded-lg p-8 text-center cursor-pointer hover:border-blue-400 transition-colors">
                <p className="text-sm text-zinc-500">TXT 파일 클릭하여 선택</p>
                <p className="text-xs text-zinc-400 mt-1">인코딩 자동 감지 (UTF-8 / EUC-KR)</p>
                {importText && <p className="text-xs text-emerald-600 mt-1">{importPreview.length}개 항목 로드됨</p>}
                <input ref={fileRef} type="file" accept=".txt" className="hidden" onChange={handleImportFile} />
              </div>
            )}

            {importPreview.length > 0 && (
              <div className="mt-3 bg-zinc-50 rounded-lg p-3 max-h-44 overflow-y-auto">
                <div className="flex items-center gap-3 mb-2">
                  <p className="text-xs font-medium text-zinc-600">미리보기</p>
                  <span className="text-xs text-emerald-600">파싱 {parsedCount}건</span>
                  {duplicateCount > 0 && <span className="text-xs text-amber-600">중복 {duplicateCount}건</span>}
                  {failedCount > 0 && <span className="text-xs text-red-500">실패 {failedCount}건</span>}
                </div>
                {importPreview.map(({ title, url, blog }, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs py-0.5">
                    <span className="text-zinc-400 w-5 text-right shrink-0">{i + 1}</span>
                    {blog && (
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${BLOG_BADGE_COLORS[blog] ?? "bg-zinc-100 text-zinc-600"}`}>
                        {blog}
                      </span>
                    )}
                    <span className="text-zinc-700 flex-1 truncate">{title}</span>
                    {url && <span className="text-blue-400 truncate max-w-[180px]">{url}</span>}
                  </div>
                ))}
              </div>
            )}

            {importPreview.length === 0 && importText.trim() && (
              <p className="mt-3 text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">
                인식된 항목이 없습니다. 인코딩을 확인하거나 파일 형식을 확인해 주세요.
              </p>
            )}

            <div className="flex justify-end gap-2 mt-5">
              <button onClick={() => { setShowImport(false); setImportText(""); setImportPreview([]); }}
                className="px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900">
                취소
              </button>
              <button onClick={handleBulkAdd} disabled={importPreview.length === 0 || importing}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed">
                {importing ? "추가 중..." : `${importPreview.length}개 추가`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
