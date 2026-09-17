import { ExternalTrackExperience } from "@/components/ExternalTrackExperience";

export default async function ExternalTrackPage({ params }: { params: Promise<{ provider: string; providerId: string }> }) {
  const { provider, providerId } = await params;
  return <ExternalTrackExperience provider={provider} providerId={providerId} />;
}
