"use client";

import Image from "next/image";
import { useEffect, useState } from "react";

import { StatusPill } from "@/components/StatusPill";
import { apiRequest } from "@/lib/api-client";
import type { components } from "@/lib/api-schema.generated";
import { useText } from "./LocaleProvider";

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
  const t = useText();
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
    let timer: number | undefined;
    const poll = async () => {
      try {
        const result = await apiRequest<ChallengeStatus>(
          `/api/v1/music-connections/netease/qr/${challenge.challenge_id}`,
        );
        if (cancelled) return;
        setStatus(result.status);
        if (result.connection) setConnection(result.connection);
        if (result.connection) window.dispatchEvent(new Event("musicscope:connection-changed"));
        if (["WAITING_SCAN", "WAITING_CONFIRM"].includes(result.status)) {
          timer = window.setTimeout(() => void poll(), 1800);
        }
      } catch {
        if (!cancelled) setStatus("FAILED");
      }
    };
    timer = window.setTimeout(() => void poll(), 1800);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
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
        <div><p className="eyebrow">{t("PRIMARY PROVIDER", "主要音乐来源")}</p><StatusPill tone={tone}>{t(stateCopy[status] || "Not connected", STATE_ZH[status] || "未连接")}</StatusPill></div>
        <h2>NetEase Cloud Music</h2>
        {connection ? <p>{t("Signed in as", "已登录：")} <strong>{connection.nickname || t("NetEase listener", "网易云音乐用户")}</strong>{t(". Your private provider session remains encrypted on the MusicScope backend.", "。私密会话由 MusicScope 后端加密保存。")}</p> : <p>{t("Use the official NetEase Cloud Music mobile app to scan and confirm. MusicScope never asks for your password.", "请使用网易云音乐官方手机应用扫码并确认。MusicScope 不会索要你的密码。")}</p>}
        <div className="action-row">
          {!connection && <button className="button button-primary" onClick={() => void createQr()} disabled={status === "CREATING_QR"} type="button">{challenge ? t("Refresh QR", "刷新二维码") : t("Generate QR", "生成二维码")}</button>}
          {connection && <button className="button button-primary" onClick={() => void synchronize()} disabled={status === "SYNCING"} type="button">{status === "SYNCING" ? t("Synchronizing…", "正在同步…") : t("Synchronize library", "同步资料库")}</button>}
          {connection && <button className="button button-quiet" onClick={() => void disconnect()} type="button">{t("Disconnect", "断开连接")}</button>}
        </div>
        {status === "SYNCING" && syncState && <p className="sync-result">{formatSyncProgress(syncState, t("en", "zh"))}</p>}
        {syncResult && <p className="sync-result">{t(`Synchronized ${syncResult.tracks} tracks across ${syncResult.playlists} playlists in ${(syncResult.timings_ms.total / 1000).toFixed(1)}s.`, `已同步 ${syncResult.tracks} 首曲目、${syncResult.playlists} 个歌单，用时 ${(syncResult.timings_ms.total / 1000).toFixed(1)} 秒。`)}</p>}
      </div>
      {challenge?.qr_image_data_url && !connection && <div className="qr-panel"><Image src={challenge.qr_image_data_url} width={220} height={220} unoptimized alt={t("NetEase Cloud Music login QR code", "网易云音乐登录二维码")} priority /><small>{t("Scan with the official app", "请使用官方应用扫码")}</small></div>}
    </article>
    <aside className="connection-sequence">
      <p className="eyebrow">{t("SECURE FLOW", "安全连接流程")}</p>
      <ol>{[t("Generate a real QR", "生成真实二维码"), t("Scan in the official app", "在官方应用中扫码"), t("Confirm on your phone", "在手机上确认"), t("Synchronize read-only library data", "以只读方式同步资料库")].map((step, index) => <li key={step}><span>0{index + 1}</span><p>{step}</p></li>)}</ol>
      <p className="privacy-note">{t("Disconnect removes credential material but preserves your synchronized canonical library.", "断开连接会移除凭证材料，但会保留已同步的规范化资料库。")}</p>
    </aside>
  </section>;
}

const STATE_ZH: Record<string, string> = { CREATING_QR: "正在生成二维码", WAITING_SCAN: "等待扫码", WAITING_CONFIRM: "已扫码，请在网易云音乐中确认", CONNECTED: "已连接", EXPIRED: "二维码已过期", FAILED: "连接失败" };

function formatSyncProgress(state: SyncState, locale: string) {
  const checkpoint = state.checkpoint ?? {};
  const stage = typeof checkpoint.stage === "string" ? checkpoint.stage : "starting";
  if (stage === "track_ids") {
    return locale === "zh" ? `歌单 ${checkpoint.playlists_processed ?? 0} / ${checkpoint.playlists_total ?? "?"} · 已找到 ${checkpoint.track_memberships_found ?? 0} 条收录关系` : `Playlists ${checkpoint.playlists_processed ?? 0} / ${checkpoint.playlists_total ?? "?"} · ${checkpoint.track_memberships_found ?? 0} memberships found`;
  }
  if (stage === "song_details") {
    return locale === "zh" ? `曲目 ${state.processed_items} / ${state.total_items ?? "?"} · 正在读取真实曲目详情` : `Tracks ${state.processed_items} / ${state.total_items ?? "?"} · fetching real song details`;
  }
  if (stage === "database_reconciliation") {
    return locale === "zh" ? `曲目 ${checkpoint.tracks_processed ?? 0} / ${checkpoint.tracks_total ?? "?"} · 正在整理规范化资料库` : `Tracks ${checkpoint.tracks_processed ?? 0} / ${checkpoint.tracks_total ?? "?"} · reconciling canonical library`;
  }
  return locale === "zh" ? "正在读取可访问的歌单…" : "Retrieving all accessible playlists…";
}
