import { StudioExperience } from "@/components/StudioExperience";

export const metadata = { title: "Studio Job" };

export default async function StudioJobPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ track?: string }>;
}) {
  const [{ id }, { track }] = await Promise.all([params, searchParams]);
  return <StudioExperience initialJobId={id} sourceTrackId={track} />;
}
