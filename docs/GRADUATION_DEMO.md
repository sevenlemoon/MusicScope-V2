# MusicScope graduation demo

Use this 5–8 minute path with the populated local environment. It relies on persisted library, recommendation, event, and Studio data where possible rather than requiring a live provider call at every step.

1. **Home** — explain the core loop: connect, understand the library, discover, find live music, and explore sound. Point out the real library counts and the compact recommendation preview.
2. **Library** — search a real artist or track, open its canonical detail page, and show that artwork, playlists, and playback use the local canonical identity.
3. **Discover** — adjust Familiar ↔ Exploratory, open a recommendation explanation, and distinguish saved evidence from an outside-library candidate.
4. **Insights** — open Music Universe, select an artist, show relationship evidence, playlist overlap, rediscovery, and the explicit genre/timeline boundaries.
5. **Live** — open the cached Live For You result or search a known artist. Show provider provenance, official/ticket links, and the coverage message.
6. **Studio** — open a completed job when available, play the synchronized four-stem mixer, and show Vocals, Drums, Bass, Other, waveform, gain, mute, solo, and master volume.
7. **Close with architecture** — Next.js → FastAPI → PostgreSQL/providers, plus the isolated Demucs worker and security boundaries.

## Fallbacks

- If NetEase is unavailable, show the existing synchronized library and explain that connection is provider-dependent. Do not claim a new sync succeeded.
- If concert providers fail, use cached verified events and the partial-coverage state. A zero result means the configured sources returned none, not that concerts do not exist.
- If the network is unavailable, continue with persisted library, recommendations, Insights, and completed local Studio jobs.
- If the model is not prepared, explain that first-use local preparation is required and use an already completed job or stop before upload. Never fabricate stems.
- On a new installation, show the empty Home and Library, then open Connect and generate a real QR. Do not use a saved session or personal library as demo seed data. A provider poll may be temporarily unavailable even after QR generation; show that state honestly.
- Before a one-click demonstration, verify that the pinned Node.js 24.21.0 runtime is available in the user's nvm installation. The launcher does not install nvm or replace system Node.
