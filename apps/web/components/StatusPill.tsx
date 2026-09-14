export function StatusPill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "ready" | "warning" }) {
  return <span className={`status-pill status-${tone}`}><i aria-hidden="true" />{children}</span>;
}

