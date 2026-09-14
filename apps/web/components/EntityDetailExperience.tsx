"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Artwork } from "@/components/Artwork";
import { EmptyState } from "@/components/EmptyState";
import { TrackRow } from "@/components/TrackRow";
import { usePlayer } from "@/components/PlayerProvider";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";

type EntityType = "artist" | "album" | "playlist" | "track";
type TrackItem = components["schemas"]["TrackItem"];
type TrackPage = components["schemas"]["TrackPage"];
type AlbumPage = components["schemas"]["AlbumPage"];

export function EntityDetailExperience({ type, id }: { type: EntityType; id: string }) {
  if (type === "artist") return <ArtistExperience id={id} />;
  if (type === "album") return <AlbumExperience id={id} />;
  if (type === "playlist") return <PlaylistExperience id={id} />;
  return <TrackExperience id={id} />;
}

function ArtistExperience({ id }: { id: string }) {
  const [detail, setDetail] = useState<components["schemas"]["ArtistDetail"] | null>(null);
  const [tracks, setTracks] = useState<TrackPage | null>(null);
  const [albums, setAlbums] = useState<AlbumPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { apiRequest<components["schemas"]["ArtistDetail"]>(`/api/v1/artists/${id}`).then(setDetail).catch(() => setFailed(true)); }, [id]);
  useEffect(() => { const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""; Promise.all([apiRequest<TrackPage>(`/api/v1/artists/${id}/tracks${query}`), apiRequest<AlbumPage>(`/api/v1/artists/${id}/albums`)]).then(([nextTracks, nextAlbums]) => { setTracks(nextTracks); setAlbums(nextAlbums); }).catch(() => setFailed(true)); }, [cursor, id]);
  if (failed) return <MissingEntity type="artist" />;
  if (!detail || !tracks || !albums) return <DetailLoading />;
  return <div className="detail-view"><DetailHero eyebrow="ARTIST / CANONICAL" name={detail.name} artwork={detail.artwork_url} meta={`${detail.library_track_count} library tracks · ${detail.represented_album_count} represented albums`} />
    <section className="detail-section"><div className="detail-section-heading"><h2>Albums in your library</h2><span>{albums.total}</span></div><div className="detail-card-row">{albums.items.map((album) => <Link className="library-card" href={`/album/${album.id}`} key={album.id}><Artwork src={album.artwork_url} alt="" /><strong>{album.title}</strong><small>{(album.artists ?? []).map((artist) => artist.name).join(", ")}</small></Link>)}</div></section>
    <PagedTracks title="Tracks involving this artist" page={tracks} setCursor={setCursor} />
  </div>;
}

function AlbumExperience({ id }: { id: string }) {
  const [detail, setDetail] = useState<components["schemas"]["AlbumDetail"] | null>(null);
  const [tracks, setTracks] = useState<TrackPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { apiRequest<components["schemas"]["AlbumDetail"]>(`/api/v1/albums/${id}`).then(setDetail).catch(() => setFailed(true)); }, [id]);
  useEffect(() => { const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""; apiRequest<TrackPage>(`/api/v1/albums/${id}/tracks${query}`).then(setTracks).catch(() => setFailed(true)); }, [cursor, id]);
  if (failed) return <MissingEntity type="album" />;
  if (!detail || !tracks) return <DetailLoading />;
  return <div className="detail-view"><DetailHero eyebrow="ALBUM / CANONICAL" name={detail.title} artwork={detail.artwork_url} meta={`${detail.library_track_count} library tracks`} relationships={(detail.artists ?? []).map((artist) => <Link key={artist.id} href={`/artist/${artist.id}`}>{artist.name}</Link>)} /><PagedTracks title="Tracks in your library" page={tracks} setCursor={setCursor} /></div>;
}

function PlaylistExperience({ id }: { id: string }) {
  const [detail, setDetail] = useState<components["schemas"]["PlaylistDetail"] | null>(null);
  const [tracks, setTracks] = useState<TrackPage | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [sort, setSort] = useState<"original" | "asc" | "desc">("original");
  const [failed, setFailed] = useState(false);
  useEffect(() => { apiRequest<components["schemas"]["PlaylistDetail"]>(`/api/v1/playlists/${id}`).then(setDetail).catch(() => setFailed(true)); }, [id]);
  useEffect(() => { const query = new URLSearchParams({ sort }); if (cursor) query.set("cursor", cursor); apiRequest<TrackPage>(`/api/v1/playlists/${id}/tracks?${query}`).then(setTracks).catch(() => setFailed(true)); }, [cursor, id, sort]);
  if (failed) return <MissingEntity type="playlist" />;
  if (!detail || !tracks) return <DetailLoading />;
  return <div className="detail-view"><DetailHero eyebrow="PLAYLIST / NETEASE" name={detail.name} artwork={detail.artwork_url} meta={`${detail.synchronized_track_count} synchronized tracks${detail.provider_track_count !== null && detail.provider_track_count !== detail.synchronized_track_count ? ` · ${detail.provider_track_count} reported by provider` : ""}`} description={detail.description} />
    <div className="detail-sort" aria-label="Playlist track order">{(["original", "asc", "desc"] as const).map((value) => <button type="button" key={value} aria-pressed={sort === value} onClick={() => { setSort(value); setCursor(null); }}>{value === "original" ? "Playlist order" : value === "asc" ? "A–Z" : "Z–A"}</button>)}</div>
    <PagedTracks title="Playlist tracks" page={tracks} setCursor={setCursor} />
  </div>;
}

function TrackExperience({ id }: { id: string }) {
  const [detail, setDetail] = useState<components["schemas"]["TrackDetail"] | null>(null);
  const [failed, setFailed] = useState(false);
  const [routing, setRouting] = useState(false);
  const player = usePlayer();
  const router = useRouter();
  useEffect(() => { apiRequest<components["schemas"]["TrackDetail"]>(`/api/v1/tracks/${id}`).then(setDetail).catch(() => setFailed(true)); }, [id]);
  if (failed) return <MissingEntity type="track" />;
  if (!detail) return <DetailLoading />;
  const track: TrackItem = { id: detail.id, title: detail.title, artwork_url: detail.artwork_url, duration_ms: detail.duration_ms, album_id: detail.album?.id ?? null, album: detail.album?.name ?? null, artists: (detail.artists ?? []).map((artist) => artist.name), artist_items: detail.artists ?? [], sort_group: "#", playlist_position: null };
  const active = player.current?.id === id;
  const separate = async () => { setRouting(true); try { const result = await apiRequest<components["schemas"]["StemEntryResponse"]>(`/api/v1/tracks/${id}/stem-jobs`, { method: "POST" }); router.push(result.studio_url); } finally { setRouting(false); } };
  return <div className="detail-view"><DetailHero eyebrow="TRACK / CANONICAL" name={detail.title} artwork={detail.artwork_url} meta={durationText(detail.duration_ms)} relationships={<>{(detail.artists ?? []).map((artist, index) => <span key={artist.id}>{index > 0 && ", "}<Link href={`/artist/${artist.id}`}>{artist.name}</Link></span>)}{detail.album && <> · <Link href={`/album/${detail.album.id}`}>{detail.album.name}</Link></>}</>} />
    <div className="detail-actions"><button className="button button-primary" type="button" onClick={() => void (active ? player.toggle() : player.playTrack(track))}>{active && player.status === "playing" ? "Pause" : "Play from NetEase"}</button><button className="button button-quiet" type="button" disabled={routing} onClick={() => void separate()}>Separate stems</button></div>
    <section className="detail-section"><div className="detail-section-heading"><h2>In your playlists</h2><span>{(detail.playlists ?? []).length}</span></div>{(detail.playlists ?? []).length ? <div className="relationship-list">{(detail.playlists ?? []).map((playlist) => <Link key={playlist.id} href={`/playlist/${playlist.id}`}>{playlist.name}<span>Open playlist →</span></Link>)}</div> : <p>This canonical track is not currently in a synchronized playlist.</p>}</section>
  </div>;
}

function DetailHero({ eyebrow, name, artwork, meta, description, relationships }: { eyebrow: string; name: string; artwork?: string | null; meta: string; description?: string | null; relationships?: React.ReactNode }) {
  return <header className="detail-hero"><Artwork src={artwork} alt="" sizes="(max-width: 767px) 180px, 280px" className="detail-artwork" /><div><p className="eyebrow">{eyebrow}</p><h1>{name}</h1>{relationships && <div className="detail-relationships">{relationships}</div>}<p className="detail-meta">{meta}</p>{description && <p className="detail-description">{description}</p>}<Link className="text-link" href="/library">← Back to library</Link></div></header>;
}

function PagedTracks({ title, page, setCursor }: { title: string; page: TrackPage; setCursor: (cursor: string | null) => void }) {
  return <section className="detail-section"><div className="detail-section-heading"><h2>{title}</h2><span>{page.range_start}–{page.range_end} of {page.total}</span></div><div className="track-list">{page.items.map((track, index) => <TrackRow track={track} key={track.id} index={(page.range_start || 1) + index} />)}</div><div className="pagination-controls"><button className="button button-quiet" type="button" disabled={!page.previous_cursor} onClick={() => setCursor(page.previous_cursor ?? null)}>Previous</button><button className="button button-quiet" type="button" disabled={!page.next_cursor} onClick={() => setCursor(page.next_cursor ?? null)}>Next</button></div></section>;
}

function DetailLoading() { return <div className="library-loading">Loading canonical details…</div>; }
function MissingEntity({ type }: { type: EntityType }) { return <EmptyState eyebrow={`${type.toUpperCase()} / UNAVAILABLE`} title={`${type[0].toUpperCase()}${type.slice(1)} could not be loaded.`} body="The canonical entity may no longer be present in the synchronized library." action={{ href: "/library", label: "Back to library" }} marker="!" />; }
function durationText(milliseconds?: number | null) { if (!milliseconds) return "Duration unavailable"; const seconds = Math.round(milliseconds / 1000); return `${Math.floor(seconds / 60)} min ${seconds % 60} sec`; }
