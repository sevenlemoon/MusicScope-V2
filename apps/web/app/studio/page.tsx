import { EmptyState } from "@/components/EmptyState";
import { PageHeading } from "@/components/PageHeading";
import { StatusPill } from "@/components/StatusPill";

export const metadata = { title: "Studio" };

export default async function StudioPage({ searchParams }: { searchParams: Promise<{ source?: string }> }) {
  const fromTrack = (await searchParams).source === "local-upload";
  return <div><PageHeading index="05" eyebrow="STUDIO / AUDIO EXPLORATION" title="Step inside the mix" body="Upload audio you are permitted to process. Provider playback and processing sources remain deliberately separate." /><section className="studio-deck"><div className="studio-grid" aria-hidden="true">{Array.from({ length: 32 }, (_, index) => <i key={index} style={{ height: `${18 + ((index * 17) % 68)}%` }} />)}</div><div className="stem-list">{["Vocals", "Drums", "Bass", "Other"].map((stem) => <div key={stem}><span>{stem}</span><div /><small>— dB</small></div>)}</div><StatusPill tone="warning">Processing engine deferred</StatusPill></section><EmptyState eyebrow={fromTrack ? "TRACK / PROCESSING SOURCE" : "AUDIO / LOCAL SOURCE"} title={fromTrack ? "Source audio is unavailable for separation." : "Use audio you can provide locally."} body={fromTrack ? "The authenticated NetEase stream is for playback only. Upload a local audio file instead when the dedicated Studio workflow is available." : "MusicScope does not treat provider playback URLs as server-side processing assets. The complete upload and four-stem workflow belongs to the dedicated Studio phase."} marker="05" /></div>;
}
