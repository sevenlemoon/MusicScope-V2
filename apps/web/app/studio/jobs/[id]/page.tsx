import { StudioExperience } from "@/components/StudioExperience";

export const metadata = { title: "Studio Job" };

export default async function StudioJobPage({ params }: { params: Promise<{ id: string }> }) {
  return <StudioExperience initialJobId={(await params).id} />;
}
