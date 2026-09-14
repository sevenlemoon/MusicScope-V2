import { PageHeading } from "@/components/PageHeading";
import { ConnectExperience } from "@/components/ConnectExperience";

export const metadata = { title: "Connect" };

export default function ConnectPage() {
  return <div>
    <PageHeading index="C" eyebrow="CONNECTION / MUSIC SOURCE" title="Connect your music" body="NetEase Cloud Music will be the first source for your real profile, playlists, tracks, artists, albums, and artwork." />
    <ConnectExperience />
  </div>;
}
