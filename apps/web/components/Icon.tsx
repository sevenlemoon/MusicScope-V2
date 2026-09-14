import type { IconName } from "@/lib/routes";

const paths: Record<IconName | "settings" | "connect" | "arrow", React.ReactNode> = {
  home: <><path d="M3 11.5 12 4l9 7.5" /><path d="M5.5 10v10h13V10M9 20v-6h6v6" /></>,
  discover: <><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2.2 4.8-4.8 2.2 2.2-4.8 4.8-2.2Z" /></>,
  library: <><path d="M5 4v16M10 4v16M15 5l4 14" /><path d="M3 4h4M8 4h4M13.5 5.5l4-1" /></>,
  live: <><path d="M4 16a11 11 0 0 1 0-8M8 13a5 5 0 0 1 0-2M20 8a11 11 0 0 1 0 8M16 11a5 5 0 0 1 0 2" /><circle cx="12" cy="12" r="2" /></>,
  studio: <><path d="M4 7v10M8 4v16M12 8v8M16 5v14M20 9v6" /></>,
  insights: <><path d="M4 19V9M10 19V5M16 19v-7M22 19V3" /><path d="M2 19h22" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></>,
  connect: <><path d="M8 12h8M12 8v8" /><circle cx="12" cy="12" r="9" /></>,
  arrow: <><path d="M5 12h14M14 7l5 5-5 5" /></>,
};

export function Icon({ name, size = 20 }: { name: keyof typeof paths; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

