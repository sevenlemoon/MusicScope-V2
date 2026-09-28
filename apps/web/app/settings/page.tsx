"use client";

import Link from "next/link";
import { StatusPill } from "@/components/StatusPill";
import { useText } from "@/components/LocaleProvider";
export default function SettingsPage() {
  const t = useText();
  return <div>
    <h1>{t("Settings", "设置")}</h1>
    <section className="settings-list">
      <div><span><strong>{t("Music connection", "音乐账号")}</strong><small>{t("Connect your NetEase account and synchronize your library.", "连接网易云账号，管理资料库同步。")}</small></span><Link className="text-link" href="/connect">{t("Manage connection", "管理连接")}</Link></div>
      <div><span><strong>{t("Local file separation", "本地文件分轨")}</strong><small>{t("Import your audio without an account.", "无需登录，即可导入自己的音频文件。")}</small></span><Link className="text-link" href="/studio?source=local-upload">{t("Import audio", "导入音频")}</Link></div>
      <div><span><strong>{t("Reduced motion", "减少动态效果")}</strong><small>{t("Follows your system preference automatically.", "自动遵循系统偏好。")}</small></span><StatusPill tone="ready">{t("Supported", "已支持")}</StatusPill></div>
    </section>
  </div>;
}
