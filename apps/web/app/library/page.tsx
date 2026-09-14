import { LibraryExperience } from "@/components/LibraryExperience";
import { PageHeading } from "@/components/PageHeading";

export const metadata = { title: "Library" };

export default function LibraryPage() {
  return <div><PageHeading index="03" eyebrow="LIBRARY / YOUR COLLECTION" title="Everything you keep" body="Browse playlists, albums, artists, and tracks with their real relationships and source-native artwork." /><LibraryExperience /></div>;
}
