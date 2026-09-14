"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { primaryRoutes } from "@/lib/routes";
import { PlayerProvider } from "./PlayerProvider";

function isActive(pathname: string, href: string): boolean {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  return <PlayerProvider><AppFrame>{children}</AppFrame></PlayerProvider>;
}

function AppFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
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
    <aside className="side-rail">
      <Link className="brand" href="/" aria-label="MusicScope home"><span className="brand-glyph">M</span><span className="brand-word">MusicScope</span><small>V2 / R2.1</small></Link>
      <nav className="desktop-nav" aria-label="Primary navigation">
        {primaryRoutes.map((item, index) => <Link key={item.href} href={item.href} aria-current={isActive(pathname, item.href) ? "page" : undefined}>
          <span className="nav-index">0{index + 1}</span><Icon name={item.icon} /><span>{item.label}</span>
        </Link>)}
      </nav>
      <div className="rail-footer">
        <Link href="/connect"><Icon name="connect" /><span>Connect music</span></Link>
        <Link href="/settings"><Icon name="settings" /><span>Settings</span></Link>
        <span className="rail-build"><i />Real library player</span>
      </div>
    </aside>

    <div className="main-column">
      <header className="topbar">
        <div><span className="topbar-context">PERSONAL MUSIC INTELLIGENCE</span><span className="topbar-line" /></div>
        <Link className="connection-control" href="/connect"><span className="connection-dot" />{connected ? "Connected" : "Not connected"}<Icon name="arrow" size={15} /></Link>
      </header>
      <main className="page-content">{children}</main>
      <footer className="app-footer"><span>MusicScope V2</span><span>Real data · canonical library · transient playback</span></footer>
    </div>

    <nav className="mobile-nav" aria-label="Primary navigation">
      {primaryRoutes.map((item) => <Link key={item.href} href={item.href} aria-label={item.label} aria-current={isActive(pathname, item.href) ? "page" : undefined}><Icon name={item.icon} size={18} /><span>{item.shortLabel}</span></Link>)}
    </nav>
  </div>;
}
