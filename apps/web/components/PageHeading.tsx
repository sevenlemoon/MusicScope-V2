"use client";

import { useLocale } from "./LocaleProvider";

const zh: Record<string, string> = {
  "CONNECTION / MUSIC SOURCE": "连接 / 音乐来源",
  "LIBRARY / YOUR COLLECTION": "资料库 / 我的收藏",
  "Connect your music": "连接你的音乐",
  "NetEase Cloud Music will be the first source for your real profile, playlists, tracks, artists, albums, and artwork.": "网易云音乐将作为真实资料库、歌单、曲目、艺人与专辑数据的首个来源。",
  "Everything you keep": "收藏的一切",
  "Browse playlists, albums, artists, and tracks with their real relationships and source-native artwork.": "浏览歌单、专辑、艺人与曲目，以及它们真实的关系和来源图片。",
  "Your MusicScope profile": "你的 MusicScope 资料",
  "Your MusicScope identity is separate from every connected music account.": "你的 MusicScope 身份与每个已连接的音乐账号彼此独立。",
  "Keep the controls yours": "掌控你的设置",
  "Connections, exploration, privacy, storage, and accessibility settings will live here.": "连接、探索、隐私、存储与无障碍设置都会集中在这里。",
  "Manage exploration and connections here. Reduced motion follows your system preference.": "在这里管理探索偏好与音乐连接；减少动态效果会遵循系统设置。",
};

export function PageHeading({ index, eyebrow, title, body }: { index: string; eyebrow: string; title: string; body: string }) {
  const { locale } = useLocale();
  const displayTitle = locale === "zh" ? (zh[title] ?? title) : title;
  const displayBody = locale === "zh" ? (zh[body] ?? body) : body;
  return <header className="page-heading">
    <div className="page-index" aria-hidden="true">{index}</div>
    <div><p className="eyebrow">{locale === "zh" ? (zh[eyebrow] ?? eyebrow) : eyebrow}</p><h1>{displayTitle}</h1><p className="page-lede">{displayBody}</p></div>
  </header>;
}
