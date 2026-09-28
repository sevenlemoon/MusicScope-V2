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
  { href: "/", label: "Stem Studio", zhLabel: "音轨分离", shortLabel: "Studio", zhShortLabel: "分轨", icon: "studio" },
  { href: "/library", label: "Library", zhLabel: "资料库", shortLabel: "Library", zhShortLabel: "资料库", icon: "library" },
];

export const secondaryRoutePatterns = [
  "/connect",
  "/album/[id]",
  "/playlist/[id]",
  "/track/[id]",
  "/settings",
  "/studio",
  "/studio/jobs/[id]",
] as const;
