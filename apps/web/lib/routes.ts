export type IconName = "home" | "discover" | "library" | "live" | "studio" | "insights";

export type NavigationItem = {
  href: string;
  label: string;
  shortLabel: string;
  icon: IconName;
};

export const primaryRoutes: NavigationItem[] = [
  { href: "/", label: "Home", shortLabel: "Home", icon: "home" },
  { href: "/discover", label: "Discover", shortLabel: "Discover", icon: "discover" },
  { href: "/library", label: "Library", shortLabel: "Library", icon: "library" },
  { href: "/live", label: "Live", shortLabel: "Live", icon: "live" },
  { href: "/studio", label: "Studio", shortLabel: "Studio", icon: "studio" },
  { href: "/insights", label: "Insights", shortLabel: "Insights", icon: "insights" },
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

