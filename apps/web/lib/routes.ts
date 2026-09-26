export type IconName = "home" | "discover" | "library" | "live" | "studio" | "insights";

export type NavigationItem = {
  href: string;
  label: string;
  zhLabel: string;
  shortLabel: string;
  zhShortLabel: string;
  icon: IconName;
};

export const primaryRoutes: NavigationItem[] = [
  { href: "/", label: "Home", zhLabel: "首页", shortLabel: "Home", zhShortLabel: "首页", icon: "home" },
  { href: "/discover", label: "Discover", zhLabel: "发现", shortLabel: "Discover", zhShortLabel: "发现", icon: "discover" },
  { href: "/library", label: "Library", zhLabel: "资料库", shortLabel: "Library", zhShortLabel: "资料库", icon: "library" },
  { href: "/live", label: "Live", zhLabel: "现场", shortLabel: "Live", zhShortLabel: "现场", icon: "live" },
  { href: "/studio", label: "Studio", zhLabel: "工作室", shortLabel: "Studio", zhShortLabel: "工作室", icon: "studio" },
  { href: "/insights", label: "Insights", zhLabel: "洞察", shortLabel: "Insights", zhShortLabel: "洞察", icon: "insights" },
];

export const secondaryRoutePatterns = [
  "/connect",
  "/artist/[id]",
  "/album/[id]",
  "/playlist/[id]",
  "/track/[id]",
  "/profile",
  "/settings",
] as const;
