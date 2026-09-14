# R0 domain model

`User` owns editable MusicScope settings and can have many `MusicConnection` records. A connection stores non-sensitive provider/account state; `MusicConnectionSecret` is a separate backend-only record for encrypted session material.

Canonical music uses `Track`, `Artist`, `Album`, and `Playlist`, with ordered many-to-many `TrackArtist`, `AlbumArtist`, and `PlaylistTrack` relationships. `ExternalIdentity(provider, entity_type, provider_id)` maps provider records to canonical UUIDs and is unique in both directions. This is the R1 deduplication key.

`LibraryItem` records user ownership plus connection provenance. `SyncState` stores resumable scope, cursor, checkpoint, counts, and safe errors. `RecommendationProfile` keeps long-term/short-term observations separate; `RecommendationFeedback` and `MusicMemory` preserve user-authored input.

`ConcertEvent` requires provider identity and a real source URL. `AudioAsset`, `StemJob`, and `StemArtifact` support durable, cacheable offline work; artifact records reserve a waveform storage key for real decoded waveform data.

The generic `ExternalIdentity.entity_id` cannot have a database foreign key to four target tables. Application services must validate `entity_type` and canonical existence transactionally; this tradeoff avoids four near-identical identity tables and is recorded as an R0 risk.

