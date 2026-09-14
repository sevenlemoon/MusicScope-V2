import Link from "next/link";
import { Icon } from "./Icon";

type EmptyStateProps = {
  eyebrow: string;
  title: string;
  body: string;
  action?: { href: string; label: string };
  marker?: string;
};

export function EmptyState({ eyebrow, title, body, action, marker = "00" }: EmptyStateProps) {
  return <section className="empty-state">
    <div className="empty-orbit" aria-hidden="true"><span>{marker}</span></div>
    <div className="empty-copy">
      <p className="eyebrow">{eyebrow}</p>
      <h2>{title}</h2>
      <p>{body}</p>
      {action && <Link className="button button-primary" href={action.href}>{action.label}<Icon name="arrow" size={17} /></Link>}
    </div>
  </section>;
}

