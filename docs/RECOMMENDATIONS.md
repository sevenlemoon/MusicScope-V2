# MusicScope R2.2 recommendation model

MusicScope R2 derives recommendations from the signed-in user's synchronized canonical library. It
does not infer listening frequency, recency, skips, popularity, or chronology because those signals
are not available in R2.

## Materialization boundary

`RecommendationProfileService.rebuild` explicitly rebuilds one user's profile after a meaningful
library change. An explicit candidate materialization step then stores reusable internal pools.
Home and Discover read these pools, apply feedback and the Familiar–Exploratory preference, and
diversify at request time. They never rebuild the profile, graph, or provider catalog while
rendering. A profile is stale when its recorded source sync timestamp differs from the user's latest
connection sync.

## Playlist and collaboration weighting

Each playlist membership has weight:

```text
w_playlist = min(1, sqrt(50 / playlist_track_count))
```

Focused playlists of up to 50 tracks retain full strength. Evidence then decays continuously by the
square root, so a 2,513-track archive contributes about `0.141055` per membership. Distinct-track
breadth uses the maximum normalized membership weight for a track, not a raw count, which prevents
an archive from regaining dominance through the breadth feature.

For a track with `n` credited artists, its membership contribution to each artist is divided by
`sqrt(n)`. This retains real collaboration evidence without assigning the full signal to every
credit.

## Artist affinity

Raw evidence is retained independently from normalized features. For each artist:

```text
track_breadth          = log1p(weighted distinct tracks) / dataset maximum
playlist_strength      = log1p(weighted memberships) / dataset maximum
album_breadth          = 1 - exp(-represented albums / 5)
repeat_strength        = 1 - exp(-repeat memberships / 4)
collaboration_strength = 1 - exp(-collaboration tracks / 6)

artist_affinity =
    0.42 * track_breadth
  + 0.25 * playlist_strength
  + 0.18 * album_breadth
  + 0.10 * repeat_strength
  + 0.05 * collaboration_strength
```

Confidence is a saturation function over weighted track breadth, playlist breadth, and album
breadth. It represents evidence strength, not a match probability.

## Album affinity

Album track breadth uses the same maximum normalized per-track playlist weight. For each album:

```text
track_strength    = 1 - exp(-weighted distinct tracks / 4)
playlist_strength = 1 - exp(-weighted memberships / 3)
artist_affinity   = mean affinity of credited album artists represented in the profile

album_affinity =
    0.45 * track_strength
  + 0.25 * playlist_strength
  + 0.30 * artist_affinity
```

This makes a fully imported album useful evidence while preventing one archive playlist from acting
like repeated preference evidence.

## Artist relationship graph

Artist pairs receive playlist co-occurrence weight equal to normalized playlist weight multiplied
by the square root of the smaller artist track support in that playlist. Direct shared-track credits
add `0.5 / sqrt(n - 1)` per pair on an `n`-artist track. Playlist and collaboration contributions
are retained separately in structured evidence.

Only relationship construction considers the 80 most represented artists per playlist, and only the
30 strongest edges per artist are materialized. Artist and album affinity are computed before this
bound from every valid membership, so graph protection never erases profile evidence. This avoids a
naive global track-pair O(N²) expansion.

## Candidate strategies and truthfulness

- `REDISCOVER`: saved tracks connected to represented artists, with underrepresented playlist
  membership favored. It never claims fake recency.
- `ARTIST_AFFINITY` and `ALBUM_AFFINITY`: top materialized canonical entities.
- `ADJACENT_ARTIST`: artists connected to a strong profile anchor by playlist co-occurrence or a
  direct collaboration.
- `EXPLORATION`: the honest R2 Hidden Gems definition—items saved once in the user's library with a
  represented artist evidence path.
- `EXTERNAL_ARTIST_CATALOG`: an unsaved provider track from a high-affinity artist's real catalog.
- `EXTERNAL_COLLABORATION`: an unsaved multi-artist provider track reached through a high-affinity
  seed artist.

## Outside-library discovery

NetEase discovery stays behind `MusicProvider`. The adapter supports bounded track/artist search,
artist songs, artist albums, and related artists using the loopback-only sidecar. The current
candidate refresh relies on artist songs because that operation preserves a direct, understandable
profile evidence path and proved reliable with the connected account. Search is a provider
capability, not the user-facing ranking model.

At most eight high-affinity artist seeds are refreshed, with at most three requests in flight and
thirty provider tracks inspected per seed. The adapter applies its normal timeout and at most three
attempts for retryable failures. One failed seed produces a partial refresh; a total failure retains
the last verified cache as stale. Fresh external candidates expire after 24 hours. Home and Discover
never make provider requests.

For each NetEase track, novelty begins with `(provider, entity_type, provider_id)`. Existing
`ExternalIdentity` rows resolve an optional canonical entity, but ownership is checked separately
through the current user's playlist memberships. A canonical track owned only by another user is
still new to the current user. Title and artist strings never decide novelty.

External metadata is stored only in `recommendation_candidates`. It preserves every provider artist
ID, album identity, duration, and artwork when present. It does not create `LibraryItem`,
`PlaylistTrack`, Track, Artist, Album, or ExternalIdentity rows. Candidate display, detail viewing,
feedback, and provider-identity playback therefore leave saved-library counts unchanged.

Library candidates are labeled `musicscope_library` and `is_in_library=true`; external candidates
are labeled `netease_external` and `is_in_library=false`. External playback uses the existing
authenticated resolver and global player through an explicit provider identity. Playback URLs stay
transient, response-only, uncached, and unlogged.

After scoring, canonical identities are deduplicated and tracks are capped at two per artist and two
per album in a result. A strategy cannot fill more than half a mixed section (with a minimum cap of
three). The persisted Familiar–Exploratory setting changes the familiar/adjacent target mix; it is
not cosmetic.

Feedback is a user-scoped upsert keyed by an explicit canonical or provider identity. `LIKE` adds a
small request-time ranking boost. `DISLIKE` and `NOT_INTERESTED` exclude the entity from the next
response without rebuilding either materialization. Explanations are generated only from the
structured evidence returned with each item.
