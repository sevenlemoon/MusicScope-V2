import { EmptyState } from "@/components/EmptyState";
import { PageHeading } from "@/components/PageHeading";

export const metadata = { title: "Live" };

export default function LivePage() {
  return <div><PageHeading index="04" eyebrow="LIVE / CONCERT DISCOVERY" title="Find the next stage" body="Search any artist directly. Your library will later add Live For You, while every event remains tied to a real source." /><form className="search-shell"><label htmlFor="artist-search">Artist search</label><div><input id="artist-search" placeholder="Concert search arrives with a provider" disabled /><button className="button button-disabled" type="submit" disabled>Search</button></div></form><EmptyState eyebrow="EVENTS / SOURCE REQUIRED" title="Concert search is not connected." body="R0 defines a multi-provider event boundary and distinct no-results, coverage, unavailable, and failure states. No event is fabricated for this shell." marker="04" /></div>;
}

