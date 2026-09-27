"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { PlayerProvider } from "./PlayerProvider";
import { LocaleProvider, LocaleToggle, useLocale } from "./LocaleProvider";

function AudioMark() {
  return <svg viewBox="0 0 36 36" fill="none" aria-hidden="true"><path d="M5 18h3m2-5v10m4-16v22m4-14v6m4-11v16m4-21v26m4-16v6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"/><path d="M4 31h28" stroke="currentColor" strokeWidth="1" opacity=".45"/></svg>;
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return <LocaleProvider><PlayerProvider><AppFrame>{children}</AppFrame></PlayerProvider></LocaleProvider>;
}

function AppFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { locale } = useLocale();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const refresh = () => {
      void apiRequest<components["schemas"]["ConnectionList"]>("/api/v1/music-connections")
        .then((result) => setConnected((result.items ?? []).some((item) => item.status === "CONNECTED")))
        .catch(() => setConnected(false));
    };
    refresh();
    window.addEventListener("musicscope:connection-changed", refresh);
    return () => window.removeEventListener("musicscope:connection-changed", refresh);
  }, [pathname]);

  return <div className="app-shell">
    <header className="tool-topbar">
      <Link className="tool-brand" href="/" aria-label={locale === "zh" ? "MusicScope 分轨首页" : "MusicScope separation home"}><span className="tool-mark"><AudioMark /></span><span><strong>MusicScope</strong><small>STEM STUDIO</small></span></Link>
      <nav className="tool-nav" aria-label={locale === "zh" ? "主导航" : "Primary navigation"}>
        <Link href="/" aria-current={pathname === "/" || pathname.startsWith("/studio") ? "page" : undefined}>{locale === "zh" ? "分轨" : "Separate"}</Link>
        <Link href="/library" aria-current={pathname.startsWith("/library") ? "page" : undefined}>{locale === "zh" ? "资料库" : "Library"}</Link>
      </nav>
      <div className="tool-actions">
        <LocaleToggle />
        <Link className="connection-control" href="/connect"><span className="connection-dot" />{connected ? (locale === "zh" ? "已连接" : "Connected") : (locale === "zh" ? "连接网易云" : "Connect NetEase")}</Link>
        <Link className="tool-settings" href="/settings" aria-label={locale === "zh" ? "设置" : "Settings"}><Icon name="settings" size={17} /></Link>
      </div>
    </header>
    <div className="main-column">
      <main className="page-content">{children}</main>
    </div>
  </div>;
}
