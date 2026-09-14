"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

import { StatusPill } from "@/components/StatusPill";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";

type Connection = components["schemas"]["ConnectionSummary"];
type Challenge = components["schemas"]["QrChallengeResponse"];
type ChallengeStatus = components["schemas"]["QrStatusResponse"];
type SyncResult = components["schemas"]["SyncResponse"];
type SyncState = components["schemas"]["SyncStateResponse"];

const stateCopy: Record<string, string> = {
  CREATING_QR: "Generating QR code",
  WAITING_SCAN: "Waiting for scan",
  WAITING_CONFIRM: "Scanned — confirm in NetEase Cloud Music",
  CONNECTED: "Connected",
  EXPIRED: "QR expired",
  FAILED: "Connection failed",
};

export function ConnectExperience() {
  const [status, setStatus] = useState("IDLE");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [syncState, setSyncState] = useState<SyncState | null>(null);

  useEffect(() => {
    apiRequest<components["schemas"]["ConnectionList"]>("/api/v1/music-connections")
      .then((result) => {
        const connected = (result.items ?? []).find((item) => item.status === "CONNECTED");
        if (connected) {
          setConnection(connected);
          setStatus("CONNECTED");
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!challenge || !["WAITING_SCAN", "WAITING_CONFIRM"].includes(status)) return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const result = await apiRequest<ChallengeStatus>(
          `/api/v1/music-connections/netease/qr/${challenge.challenge_id}`,
        );
        if (cancelled) return;
        setStatus(result.status);
        if (result.connection) setConnection(result.connection);
        if (result.connection) window.dispatchEvent(new Event("musicscope:connection-changed"));
      } catch {
        if (!cancelled) setStatus("FAILED");
      }
    }, 1800);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [challenge, status]);

  useEffect(() => {
    if (!connection || status !== "SYNCING") return;
    let cancelled = false;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const result = await apiRequest<SyncState>(
          `/api/v1/music-connections/${connection.id}/sync`,
        );
        if (!cancelled) setSyncState(result);
      } finally {
        if (!cancelled) timer = window.setTimeout(() => void poll(), 900);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [connection, status]);

  const createQr = async () => {
    setStatus("CREATING_QR");
    setChallenge(null);
    setSyncResult(null);
    try {
      const result = await apiRequest<Challenge>("/api/v1/music-connections/netease/qr", {
        method: "POST",
      });
      setChallenge(result);
      setStatus(result.status);
    } catch {
      setStatus("FAILED");
    }
  };

  const synchronize = async () => {
    if (!connection) return;
    setStatus("SYNCING");
    setSyncResult(null);
    setSyncState(null);
    try {
      const result = await apiRequest<SyncResult>(
        `/api/v1/music-connections/${connection.id}/sync`,
        { method: "POST" },
      );
      setSyncResult(result);
      setStatus("CONNECTED");
    } catch {
      setStatus("FAILED");
    }
  };

  const disconnect = async () => {
    if (!connection) return;
    await apiRequest(`/api/v1/music-connections/${connection.id}`, { method: "DELETE" });
    setConnection(null);
    setChallenge(null);
    setSyncResult(null);
    setSyncState(null);
    setStatus("DISCONNECTED");
    window.dispatchEvent(new Event("musicscope:connection-changed"));
  };

  const tone = status === "CONNECTED" ? "ready" : status === "FAILED" ? "warning" : "neutral";
  return <section className="connect-layout">
    <article className="provider-card provider-card-live">
      <div className="provider-mark">N</div>
      <div className="provider-copy">
        <div><p className="eyebrow">PRIMARY PROVIDER</p><StatusPill tone={tone}>{stateCopy[status] || "Not connected"}</StatusPill></div>
        <h2>NetEase Cloud Music</h2>
        {connection ? <p>Signed in as <strong>{connection.nickname || "NetEase listener"}</strong>. Your private provider session remains encrypted on the MusicScope backend.</p> : <p>Use the official NetEase Cloud Music mobile app to scan and confirm. MusicScope never asks for your password.</p>}
        <div className="action-row">
          {!connection && <button className="button button-primary" onClick={() => void createQr()} disabled={status === "CREATING_QR"} type="button">{challenge ? "Refresh QR" : "Generate QR"}</button>}
          {connection && <button className="button button-primary" onClick={() => void synchronize()} disabled={status === "SYNCING"} type="button">{status === "SYNCING" ? "Synchronizing…" : "Synchronize library"}</button>}
          {connection && <button className="button button-quiet" onClick={() => void disconnect()} type="button">Disconnect</button>}
        </div>
        {status === "SYNCING" && syncState && <p className="sync-result">{formatSyncProgress(syncState)}</p>}
        {syncResult && <p className="sync-result">Synchronized {syncResult.tracks} tracks across {syncResult.playlists} playlists in {(syncResult.timings_ms.total / 1000).toFixed(1)}s.</p>}
      </div>
      {challenge?.qr_image_data_url && !connection && <div className="qr-panel"><Image src={challenge.qr_image_data_url} width={220} height={220} unoptimized alt="NetEase Cloud Music login QR code" priority /><small>Scan with the official app</small></div>}
    </article>
    <aside className="connection-sequence">
      <p className="eyebrow">SECURE FLOW</p>
      <ol>{["Generate a real QR", "Scan in the official app", "Confirm on your phone", "Synchronize read-only library data"].map((step, index) => <li key={step}><span>0{index + 1}</span><p>{step}</p></li>)}</ol>
      <p className="privacy-note">Disconnect removes credential material but preserves your synchronized canonical library.</p>
    </aside>
  </section>;
}

function formatSyncProgress(state: SyncState) {
  const checkpoint = state.checkpoint ?? {};
  const stage = typeof checkpoint.stage === "string" ? checkpoint.stage : "starting";
  if (stage === "track_ids") {
    return `Playlists ${checkpoint.playlists_processed ?? 0} / ${checkpoint.playlists_total ?? "?"} · ${checkpoint.track_memberships_found ?? 0} memberships found`;
  }
  if (stage === "song_details") {
    return `Tracks ${state.processed_items} / ${state.total_items ?? "?"} · fetching real song details`;
  }
  if (stage === "database_reconciliation") {
    return `Tracks ${checkpoint.tracks_processed ?? 0} / ${checkpoint.tracks_total ?? "?"} · reconciling canonical library`;
  }
  return "Retrieving all accessible playlists…";
}
