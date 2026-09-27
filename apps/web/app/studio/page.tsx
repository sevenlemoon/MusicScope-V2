import { StudioExperience } from "@/components/StudioExperience";

export const metadata = { title: "Studio" };

export default async function StudioPage({ searchParams }: { searchParams: Promise<{ track?: string }> }) {
  const { track } = await searchParams;
  return <StudioExperience sourceTrackId={track} />;
}
