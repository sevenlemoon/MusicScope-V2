import { LiveEventDetail } from "@/components/LiveEventDetail";

export default async function LiveEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LiveEventDetail id={id} />;
}
