"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/dashboard", label: "대시보드", icon: "▦", admin: false },
  { href: "/topics", label: "글목록", icon: "◈", admin: false },
  { href: "/pipeline", label: "글쓰기 실행", icon: "▶", admin: false },
  { href: "/posts", label: "발행 인덱스", icon: "≡", admin: false },
  { href: "/eval", label: "운영 리포트", icon: "◉", admin: true },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 min-h-screen bg-zinc-900 text-zinc-100 flex flex-col">
      <div className="px-5 py-6 border-b border-zinc-800">
        <p className="text-xs text-zinc-500 uppercase tracking-widest">Blog Automation</p>
        <p className="text-sm font-semibold mt-1 text-white">네이버 블로그</p>
      </div>

      <nav className="flex-1 py-4">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-5 py-2.5 text-sm transition-colors ${
                active
                  ? "bg-zinc-800 text-white font-medium"
                  : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              }`}
            >
              <span className="text-base">{item.icon}</span>
              <span className="flex-1">{item.label}</span>
              {item.admin && (
                <span className="text-[10px] px-1.5 py-0.5 bg-zinc-700 text-zinc-400 rounded">관리자</span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="px-5 py-4 border-t border-zinc-800 text-xs text-zinc-600">
        v1.0 — 운영 중
      </div>
    </aside>
  );
}
