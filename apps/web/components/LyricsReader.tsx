"use client";

import { currentLyricIndex } from "@/lib/lyrics";
import type { LyricsState } from "@/hooks/useTrackLyrics";
import { useLyricViewport } from "@/hooks/useLyricViewport";
import { useText } from "./LocaleProvider";
import styles from "./LyricsReader.module.css";

export function LyricsReader({ lyrics, position, seekRevision, onSeek, onRetry }: { lyrics: LyricsState; position: number; seekRevision: number; onSeek: (at: number) => void; onRetry: () => void }) {
  const t = useText();
  const lines = lyrics.parsed?.lines;
  const index = currentLyricIndex(lines ?? [], position);
  const { container, content, elements, manual, browse, follow } = useLyricViewport(lines, index, seekRevision, lyrics.document?.track_id);

  if (lyrics.status === "loading") return <div className={styles.empty} role="status"><span className={styles.symbol}>♫</span><h3>{t("Finding the words…", "正在寻找歌词…")}</h3><p>{t("Loading lyrics from NetEase Music", "正在读取网易云音乐歌词")}</p></div>;
  if (lyrics.status === "error") return <div className={styles.empty} role="status"><h3>{t("Lyrics couldn’t load", "歌词暂时未能加载")}</h3><p>{t("Your music can keep playing.", "音乐仍可继续播放。")}</p><button type="button" onClick={onRetry}>{t("Try again", "重新加载歌词")}</button></div>;
  const kind = lyrics.document?.kind;
  if (kind === "instrumental" || kind === "none" || (!lines?.length && !lyrics.parsed?.plain.length)) return <div className={styles.empty}><span className={styles.symbol}>♫</span><h3>{kind === "instrumental" ? t("Just the music.", "让音乐说话。") : t("No lyrics available", "暂无歌词")}</h3><p>{kind === "instrumental" ? t("Instrumental · no lyrics", "纯音乐 · 无歌词") : t("This source hasn’t provided lyrics for this track.", "此来源暂未提供这首歌的歌词。")}</p></div>;

  return <div className={styles.reader}>
    <div className={styles.caption}>{lines?.length ? t("NETEASE MUSIC · LINE-SYNCED LYRICS", "网易云音乐 · 逐行同步歌词") : t("NETEASE MUSIC · UNSYNCED LYRICS", "网易云音乐 · 无时间轴歌词")}</div>
    <div className={styles.scroll} ref={container} tabIndex={0} aria-label={t("Lyrics", "歌词")} onWheel={browse} onTouchMove={browse} onPointerDown={event => { if (event.target === event.currentTarget) browse(); }} onKeyDown={event => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) browse(); }}>
      {lines?.length ? <div ref={content} className={styles.lines}>{lines.map((line, i) => <button type="button" key={`${i}-${line.at}`} ref={element => { elements.current[i] = element; }} className={`${styles.line} ${i === index ? styles.current : Math.abs(i - index) === 1 ? styles.near : styles.far}`} data-lyric-time={line.at} aria-current={i === index ? "true" : undefined} aria-label={`${t("Seek to", "定位到")} ${Math.floor(line.at / 60)}:${Math.floor(line.at % 60).toString().padStart(2, "0")} · ${line.text || t("Instrumental break", "间奏")}`} onClick={() => { follow(); onSeek(line.at); }}>
        <span>{line.text || "•••"}</span>{line.translation && <small>{line.translation}</small>}
      </button>)}</div> : <div className={styles.plain}>{lyrics.parsed?.plain.map((line, i) => <p key={i}>{line}</p>)}</div>}
    </div>
    {manual && lines?.length ? <button type="button" className={styles.follow} onClick={follow}>{t("Back to current line", "返回当前歌词")} <span aria-hidden="true">↗</span></button> : <p className={styles.hint}>{lines?.length ? t("Select a line to seek · scroll to explore", "点击歌词定位 · 滚动自由阅读") : t("No timing data provided · reading only", "来源未提供时间数据 · 仅供阅读")}</p>}
  </div>;
}
