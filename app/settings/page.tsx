"use client";

import { useState, useEffect } from "react";

interface TokenStatus {
  ok: boolean;
  tokenSet: boolean;
  source: string;
  preview: string | null;
}

interface SetupStatus {
  ok: boolean;
  tokenSet: boolean;
  tokenSource: string;
  appUrl: string | null;
  info: { url?: string; has_custom_certificate?: boolean } | null;
}

export default function SettingsPage() {
  const [tokenStatus, setTokenStatus] = useState<TokenStatus | null>(null);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  async function loadStatus() {
    const [t, s] = await Promise.all([
      fetch("/api/telegram/token").then((r) => r.json()),
      fetch("/api/telegram/setup?action=status").then((r) => r.json()),
    ]);
    setTokenStatus(t);
    setSetupStatus(s);
  }

  useEffect(() => { loadStatus(); }, []);

  async function handleSave() {
    if (!token.trim()) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/telegram/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        setMessage({ type: "ok", text: `저장 완료: ${data.preview}` });
        setToken("");
        await loadStatus();
      } else {
        setMessage({ type: "err", text: data.error });
      }
    } catch (e) {
      setMessage({ type: "err", text: String(e) });
    } finally {
      setSaving(false);
    }
  }

  async function handleRegister() {
    setRegistering(true);
    setMessage(null);
    try {
      const res = await fetch("/api/telegram/setup?action=register");
      const data = await res.json();
      if (data.ok) {
        setMessage({ type: "ok", text: `웹훅 등록 완료: ${data.webhookUrl}` });
        await loadStatus();
      } else {
        setMessage({ type: "err", text: data.error });
      }
    } catch (e) {
      setMessage({ type: "err", text: String(e) });
    } finally {
      setRegistering(false);
    }
  }

  return (
    <div className="max-w-xl mx-auto p-6 space-y-6">
      <h1 className="text-2xl font-bold">설정</h1>

      {/* 현재 상태 */}
      <section className="border rounded p-4 space-y-2">
        <h2 className="font-semibold">Telegram 봇 상태</h2>
        {tokenStatus ? (
          <div className="text-sm space-y-1">
            <div>토큰: {tokenStatus.tokenSet ? `✅ 설정됨 (${tokenStatus.source}) — ${tokenStatus.preview}` : "❌ 미설정"}</div>
            <div>웹훅: {setupStatus?.info?.url ? `✅ ${setupStatus.info.url}` : "❌ 미등록"}</div>
          </div>
        ) : (
          <div className="text-sm text-gray-500">로딩 중...</div>
        )}
      </section>

      {/* 토큰 입력 */}
      <section className="border rounded p-4 space-y-3">
        <h2 className="font-semibold">봇 토큰 설정</h2>
        <p className="text-sm text-gray-600">
          BotFather에서 받은 토큰을 입력하세요. (예: 123456789:ABC...)
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            className="flex-1 border rounded px-3 py-2 text-sm font-mono"
            placeholder="123456789:ABCDEF..."
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSave()}
          />
          <button
            onClick={handleSave}
            disabled={saving || !token.trim()}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm disabled:opacity-50"
          >
            {saving ? "저장 중..." : "저장"}
          </button>
        </div>
      </section>

      {/* 웹훅 등록 */}
      {tokenStatus?.tokenSet && (
        <section className="border rounded p-4 space-y-3">
          <h2 className="font-semibold">웹훅 등록</h2>
          <p className="text-sm text-gray-600">
            토큰이 설정되면 웹훅을 등록해야 Telegram 메시지를 받을 수 있습니다.
          </p>
          <button
            onClick={handleRegister}
            disabled={registering}
            className="px-4 py-2 bg-green-600 text-white rounded text-sm disabled:opacity-50"
          >
            {registering ? "등록 중..." : "웹훅 자동 등록"}
          </button>
        </section>
      )}

      {/* 결과 메시지 */}
      {message && (
        <div className={`rounded p-3 text-sm ${message.type === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"}`}>
          {message.text}
        </div>
      )}
    </div>
  );
}
