"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { Artwork } from "@/components/Artwork";
import { formatEventTime } from "@/components/LiveExperience";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { useText } from "./LocaleProvider";

type LiveEvent = components["schemas"]["ConcertEventResponse"];

export function LiveEventDetail({ id }: { id: string }) {
  const t = useText();
  const [event, setEvent] = useState<LiveEvent | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { apiRequest<LiveEvent>(`/api/v1/live/events/${id}`).then(setEvent).catch(() => setFailed(true)); }, [id]);
  if (failed) return <div className="live-detail-missing"><p className="eyebrow">{t("LIVE / UNAVAILABLE", "现场 / 暂不可用")}</p><h1>{t("This event could not be loaded.", "无法读取此演出。")}</h1><Link className="button button-quiet" href="/live">{t("Back to Live", "返回现场")}</Link></div>;
  if (!event) return <div className="live-loading"><span /><p>{t("Loading verified event details…", "正在读取已验证演出详情…")}</p></div>;
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(new Date(`${event.start_date}T12:00:00`));
  return <article className="live-detail">
    <header className="live-detail-hero"><Artwork src={event.artwork_url} alt="" className="live-detail-artwork" sizes="(max-width: 767px) 100vw, 46vw" eager /><div><p className="eyebrow">{t("LIVE EVENT", "现场演出")} / {event.status?.replaceAll("_", " ") || t("STATUS UNKNOWN", "状态未知")}</p><h1>{event.title}</h1><p className="live-detail-performers">{(event.performers ?? []).map((performer) => performer.name).join(" · ") || event.primary_artist_name}</p><div className="live-detail-time"><strong>{date}</strong><span>{formatEventTime(event, t("en", "zh") === "zh" ? "zh" : "en")}</span></div><div className="action-row"><a className="button button-primary" href={event.ticket_url || event.event_url} target="_blank" rel="noreferrer noopener">{event.ticket_url ? t("View tickets", "查看票务") : t("View event", "查看演出")}</a><Link className="button button-quiet" href="/live">{t("Back to Live", "返回现场")}</Link></div></div></header>
    <section className="live-detail-grid"><div><p className="eyebrow">{t("VENUE / LOCAL EVENT DATA", "场馆 / 本地演出资料")}</p><h2>{event.venue_name || t("Venue to be announced", "场馆待公布")}</h2><p>{[event.venue_address, event.city, event.region, event.country].filter(Boolean).join(" · ") || t("Location details are not available from the source.", "来源尚未提供地点详情。")}</p></div><div><p className="eyebrow">{t("WHY THIS APPEARS", "显示原因")}</p><h3>{event.explanation || t("Found through a direct artist search.", "由艺人搜索找到。")}</h3>{(event.personalization_evidence ?? []).map((item) => <span key={item.code}>{item.label}: {String(item.value)}</span>)}</div></section>
    <section className="live-sources"><div><p className="eyebrow">{t("PROVENANCE / RETAINED", "来源 / 完整保留")}</p><h2>{t("Verified sources", "已验证来源")}</h2><p>{t("MusicScope keeps each provider identity even when multiple sources describe one logical concert.", "即使多个来源描述同一场演出，MusicScope 也会保留每个来源的身份信息。")}</p></div>{(event.sources ?? []).map((source) => <a href={source.event_url} target="_blank" rel="noreferrer noopener" key={`${source.provider}:${source.provider_event_id}`}><strong>{source.provider}</strong><span>{t("Observed", "记录于")} {new Date(source.observed_at).toLocaleDateString()}</span><small>{t("Open source ↗", "打开来源 ↗")}</small></a>)}</section>
  </article>;
}
