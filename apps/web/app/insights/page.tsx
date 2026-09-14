import { EmptyState } from "@/components/EmptyState";
import { PageHeading } from "@/components/PageHeading";

export const metadata = { title: "Insights" };

export default function InsightsPage() {
  return <div><PageHeading index="06" eyebrow="INSIGHTS / MUSIC DNA" title="See how your taste moves" body="Long-term taste and short-term listening state stay separate, with every insight derived from real library and behavior signals." /><div className="insight-skeleton" aria-hidden="true"><div className="insight-ring"><span>—</span><small>MUSIC DNA</small></div><div className="insight-lines"><i /><i /><i /><i /></div></div><EmptyState eyebrow="INSIGHTS / WAITING" title="Insights begin after sync." body="Music DNA, artists, albums, clusters, eras, discovery level, and the Music Universe will appear only when enough real evidence exists." action={{ href: "/connect", label: "Connect music" }} marker="06" /></div>;
}

