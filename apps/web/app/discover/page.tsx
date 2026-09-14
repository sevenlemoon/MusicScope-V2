import { EmptyState } from "@/components/EmptyState";
import { PageHeading } from "@/components/PageHeading";

export const metadata = { title: "Discover" };

export default function DiscoverPage() {
  return <div><PageHeading index="02" eyebrow="DISCOVER / EXPLORATION" title="Go beyond familiar" body="MusicScope will combine your long-term taste, recent state, feedback, and an exploration setting you control." /><EmptyState eyebrow="RECOMMENDATIONS / WAITING" title="No recommendations yet." body="Connect and synchronize a real library first. Recommendations will include the signals behind each choice; this page never substitutes hard-coded cards." action={{ href: "/connect", label: "Connect music" }} marker="02" /></div>;
}

