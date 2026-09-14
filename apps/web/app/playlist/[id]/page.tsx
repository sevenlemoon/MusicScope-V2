import { EntityDetailExperience } from "@/components/EntityDetailExperience";
export default async function PlaylistPage({ params }: { params: Promise<{ id: string }> }) { return <EntityDetailExperience type="playlist" id={(await params).id} />; }
