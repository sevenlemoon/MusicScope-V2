import Link from "next/link";
import { PageHeading } from "./PageHeading";

export function EntityShell({ type, id }: { type: "Artist" | "Album" | "Playlist" | "Track"; id: string }) {
  return <div><PageHeading index="·" eyebrow={`${type.toUpperCase()} / DETAIL`} title={`${type} not available`} body={`This route is ready for a real canonical ${type.toLowerCase()} identity. No entity with ID “${id}” has been synchronized in R0.`} /><div className="entity-empty"><span className="entity-token">{type.slice(0, 1)}</span><div><h2>Connect and sync first.</h2><p>Provider IDs will resolve through MusicScope&apos;s canonical domain rather than title-and-artist strings.</p><Link className="button button-primary" href="/connect">Connect music</Link></div></div></div>;
}

