import { EntityDetailExperience } from "@/components/EntityDetailExperience";
export default async function TrackPage({ params }: { params: Promise<{ id: string }> }) { return <EntityDetailExperience type="track" id={(await params).id} />; }
