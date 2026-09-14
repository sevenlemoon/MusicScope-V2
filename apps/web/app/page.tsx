import Link from "next/link";
import { EmptyState } from "@/components/EmptyState";
import { Icon } from "@/components/Icon";
import { StatusPill } from "@/components/StatusPill";

export default function HomePage() {
  return <div className="home-page">
    <section className="home-intro">
      <div className="home-copy">
        <StatusPill>R0 · Foundation ready</StatusPill>
        <p className="eyebrow">YOUR MUSIC, UNDERSTOOD</p>
        <h1>Build a world<br />around what you hear.</h1>
        <p className="home-lede">Connect your music to turn a real library into explainable discovery, nearby live shows, and new ways to explore sound.</p>
        <div className="action-row">
          <Link className="button button-primary" href="/connect">Connect music<Icon name="arrow" size={17} /></Link>
          <Link className="button button-quiet" href="/library">Open library</Link>
        </div>
      </div>
      <div className="signal-field" aria-hidden="true">
        <span className="signal-disc signal-disc-a" /><span className="signal-disc signal-disc-b" />
        <div className="signal-core"><span>MS</span><small>NO SIGNAL</small></div>
        <span className="signal-label label-a">LIBRARY / 0000</span><span className="signal-label label-b">SOURCE / NONE</span>
      </div>
    </section>

    <section className="journey-strip" aria-label="MusicScope journey">
      {["Connect", "Library", "Understand", "Discover", "Live", "Sound"].map((step, index) => <div key={step}><span>0{index + 1}</span><strong>{step}</strong></div>)}
    </section>

    <EmptyState eyebrow="HOME / PERSONAL SIGNAL" title="Your space starts with your music." body="No music connection exists yet. Once a real library is synchronized, this page will surface recommendations, recent listening, live shows, and rediscovery—without placeholder data." action={{ href: "/connect", label: "Connect NetEase" }} marker="01" />
  </div>;
}

