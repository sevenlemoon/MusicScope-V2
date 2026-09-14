import { EntityDetailExperience } from "@/components/EntityDetailExperience";
export default async function ArtistPage({ params }: { params: Promise<{ id: string }> }) { return <EntityDetailExperience type="artist" id={(await params).id} />; }
