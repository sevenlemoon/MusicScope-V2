import { PageHeading } from "@/components/PageHeading";
import { StatusPill } from "@/components/StatusPill";
export const metadata = { title: "Settings" };
export default function SettingsPage() { return <div><PageHeading index="S" eyebrow="SETTINGS / CONTROL" title="Keep the controls yours" body="Connections, exploration, privacy, storage, and accessibility settings will live here." /><section className="settings-list"><div><span><strong>Exploration level</strong><small>MusicScope may suggest a change, but never applies one silently.</small></span><StatusPill>Not available in R0</StatusPill></div><div><span><strong>Music connections</strong><small>Provider sessions are managed by the backend.</small></span><a className="text-link" href="/connect">Open connect</a></div><div><span><strong>Reduced motion</strong><small>The interface follows your system preference automatically.</small></span><StatusPill tone="ready">Supported</StatusPill></div></section></div>; }

