import { EmptyState } from "@/components/EmptyState";
import { PageHeading } from "@/components/PageHeading";
export const metadata = { title: "Profile" };
export default function ProfilePage() { return <div><PageHeading index="P" eyebrow="PROFILE / MUSICSCOPE USER" title="Your MusicScope profile" body="Your MusicScope identity is separate from every connected music account." /><EmptyState eyebrow="PROFILE / LOCAL" title="No profile data yet." body="Connection metadata and personal meaning will remain editable and distinct from provider-observed facts." action={{ href: "/connect", label: "Connect music" }} marker="P" /></div>; }

