"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Artwork } from "@/components/Artwork";
import { formatEventTime } from "@/components/LiveExperience";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";

type LiveEvent = components["schemas"]["ConcertEventResponse"];

export function LiveEventDetail({ id }: { id: string }) {
  const [event, setEvent] = useState<LiveEvent | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { apiRequest<LiveEvent>(`/api/v1/live/events/${id}`).then(setEvent).catch(() => setFailed(true)); }, [id]);
  if (failed) return <div className="live-detail-missing"><p className="eyebrow">LIVE / UNAVAILABLE</p><h1>This event could not be loaded.</h1><Link className="button button-quiet" href="/live">Back to Live</Link></div>;
  if (!event) return <div className="live-loading"><span /><p>Loading verified event details…</p></div>;
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(new Date(`${event.start_date}T12:00:00`));
  return <article className="live-detail">
    <header className="live-detail-hero"><Artwork src={event.artwork_url} alt="" className="live-detail-artwork" sizes="(max-width: 767px) 100vw, 46vw" /><div><p className="eyebrow">LIVE EVENT / {event.status?.replaceAll("_", " ") || "STATUS UNKNOWN"}</p><h1>{event.title}</h1><p className="live-detail-performers">{(event.performers ?? []).map((performer) => performer.name).join(" · ") || event.primary_artist_name}</p><div className="live-detail-time"><strong>{date}</strong><span>{formatEventTime(event)}</span></div><div className="action-row"><a className="button button-primary" href={event.ticket_url || event.event_url} target="_blank" rel="noreferrer noopener">{event.ticket_url ? "View tickets" : "View event"}</a><Link className="button button-quiet" href="/live">Back to Live</Link></div></div></header>
    <section className="live-detail-grid"><div><p className="eyebrow">VENUE / LOCAL EVENT DATA</p><h2>{event.venue_name || "Venue to be announced"}</h2><p>{[event.venue_address, event.city, event.region, event.country].filter(Boolean).join(" · ") || "Location details are not available from the source."}</p></div><div><p className="eyebrow">WHY THIS APPEARS</p><h3>{event.explanation || "Found through a direct artist search."}</h3>{(event.personalization_evidence ?? []).map((item) => <span key={item.code}>{item.label}: {String(item.value)}</span>)}</div></section>
    <section className="live-sources"><div><p className="eyebrow">PROVENANCE / RETAINED</p><h2>Verified sources</h2><p>MusicScope keeps each provider identity even when multiple sources describe one logical concert.</p></div>{(event.sources ?? []).map((source) => <a href={source.event_url} target="_blank" rel="noreferrer noopener" key={`${source.provider}:${source.provider_event_id}`}><strong>{source.provider}</strong><span>Observed {new Date(source.observed_at).toLocaleDateString()}</span><small>Open source ↗</small></a>)}</section>
  </article>;
}
