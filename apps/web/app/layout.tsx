import type { Metadata, Viewport } from "next";
import { AppShell } from "@/components/AppShell";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "MusicScope", template: "%s · MusicScope" },
  description: "Personal music intelligence, discovery, live music, and audio exploration.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#090b10",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><AppShell>{children}</AppShell></body></html>;
}

