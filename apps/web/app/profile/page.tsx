"use client";

import { EmptyState } from "@/components/EmptyState";
import { PageHeading } from "@/components/PageHeading";
import { useText } from "@/components/LocaleProvider";

export default function ProfilePage() { const t = useText(); return <div><PageHeading index="P" eyebrow={t("PROFILE / MUSICSCOPE USER", "资料 / MUSICSCOPE 用户")} title="Your MusicScope profile" body="Your MusicScope identity is separate from every connected music account." /><EmptyState eyebrow={t("PROFILE / LOCAL", "资料 / 本地")} title={t("No profile data yet.", "尚无个人资料。") } body={t("Connection metadata and personal meaning will remain editable and distinct from provider-observed facts.", "连接信息与个人标注将可编辑，并与来源观察到的事实分开保存。") } action={{ href: "/connect", label: t("Connect music", "连接音乐") }} marker="P" /></div>; }
