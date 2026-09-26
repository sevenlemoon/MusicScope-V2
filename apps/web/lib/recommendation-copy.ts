import type { components } from "./api-schema.generated";

type Recommendation = components["schemas"]["RecommendationItem"];

const EVIDENCE_ZH: Record<string, string> = {
  ARTIST_LIBRARY_TRACK_COUNT: "资料库曲目",
  ARTIST_PLAYLIST_COUNT: "相关歌单",
  ARTIST_ALBUM_COUNT: "相关专辑",
  ALBUM_LIBRARY_TRACK_COUNT: "资料库曲目",
  ALBUM_PLAYLIST_COUNT: "相关歌单",
  RELATED_ARTIST_AFFINITY: "相关艺人亲和度",
  REDISCOVERY_SIGNAL: "歌单收录次数",
  PLAYLIST_CO_OCCURRENCE: "共同歌单",
  COLLABORATION_RELATIONSHIP: "合作曲目",
  AFFINITY_ANCHOR: "关联艺人",
  AFFINITY_SEED: "关联艺人",
  SEED_ARTIST_AFFINITY: "艺人亲和度",
  PROVIDER_CATALOG_RANK: "艺人目录位置",
};

export function evidenceLabel(code: string, fallback: string, locale: "zh" | "en") {
  return locale === "zh" ? EVIDENCE_ZH[code] ?? fallback : fallback;
}

export function recommendationExplanation(item: Recommendation, locale: "zh" | "en") {
  if (locale === "en") return item.explanation;
  const value = (code: string) => item.evidence?.find((entry) => entry.code === code)?.value;
  switch (item.strategy) {
    case "ARTIST_AFFINITY":
      return `${value("ARTIST_LIBRARY_TRACK_COUNT") ?? "多首"} 首曲目、${value("ARTIST_PLAYLIST_COUNT") ?? "多个"} 个歌单为此艺人提供资料库证据。`;
    case "ALBUM_AFFINITY":
      return `这张专辑有 ${value("ALBUM_LIBRARY_TRACK_COUNT") ?? "多首"} 首已收藏曲目，出现在 ${value("ALBUM_PLAYLIST_COUNT") ?? "多个"} 个歌单中。`;
    case "REDISCOVER":
      return `已收藏曲目，与资料库中的艺人 ${item.track?.artists?.[0] ?? ""} 有关联，但在当前画像中代表性较低。`;
    case "EXPLORATION":
      return "这首曲目只在资料库歌单中出现过一次，推荐依据是艺人关系，而非全局热度。";
    case "ADJACENT_ARTIST": {
      const anchor = value("AFFINITY_ANCHOR") ?? "相关艺人";
      const playlists = Number(value("PLAYLIST_CO_OCCURRENCE") ?? 0);
      return playlists > 0 ? `在 ${playlists} 个歌单中与 ${anchor} 一同出现。` : `通过 ${value("COLLABORATION_RELATIONSHIP") ?? "多首"} 首合作曲目与 ${anchor} 关联。`;
    }
    case "EXTERNAL_COLLABORATION":
      return `尚未收藏的合作曲目；${value("AFFINITY_SEED") ?? "相关艺人"} 在你的资料库中有较强证据。`;
    case "EXTERNAL_ARTIST_CATALOG":
      return `尚未收藏的曲目；${value("AFFINITY_SEED") ?? "相关艺人"} 在你的资料库中有较强证据。`;
    default:
      return item.explanation;
  }
}
