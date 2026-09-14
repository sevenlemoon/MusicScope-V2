import { EntityDetailExperience } from "@/components/EntityDetailExperience";
export default async function AlbumPage({ params }: { params: Promise<{ id: string }> }) { return <EntityDetailExperience type="album" id={(await params).id} />; }
