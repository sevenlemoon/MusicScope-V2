const test = require("node:test");
const assert = require("node:assert/strict");

test("sidecar is constrained to loopback and read-only routes", () => {
  const source = require("node:fs").readFileSync(require.resolve("./server.cjs"), "utf8");
  assert.match(source, /const HOST = "127\.0\.0\.1"/);
  for (const mutation of ["playlist\/create", "playlist\/delete", "playlist\/tracks", "\/like"]) {
    assert.doesNotMatch(source, new RegExp(mutation));
  }
});

test("upstream diagnostics are suppressed before they can expose response cookies", () => {
  const source = require("node:fs").readFileSync(require.resolve("./provider.cjs"), "utf8");
  assert.match(source, /AsyncLocalStorage/);
  assert.match(source, /getStore\(\)\?\.suppress/);
  assert.match(source, /providerLogContext\.run\(\{ suppress: true \}/);
});

test("discovery routes expose only bounded read-only provider operations", () => {
  const server = require("node:fs").readFileSync(require.resolve("./server.cjs"), "utf8");
  const provider = require("node:fs").readFileSync(require.resolve("./provider.cjs"), "utf8");
  for (const route of ["/v1/search/tracks", "/v1/search/artists", "/v1/artists/songs", "/v1/artists/albums", "/v1/artists/related"]) {
    assert.match(server, new RegExp(route.replaceAll("/", "\\/")));
  }
  for (const operation of ["cloudsearch", "artist_songs", "artist_album", "simi_artist"]) {
    assert.match(provider, new RegExp(`${operation}: moduleCall`));
  }
  assert.match(server, /Math\.min\(parsed, maximum\)/);
});

test("collected albums use only the provider's read-only subscription list", () => {
  const server = require("node:fs").readFileSync(require.resolve("./server.cjs"), "utf8");
  const provider = require("node:fs").readFileSync(require.resolve("./provider.cjs"), "utf8");
  assert.match(server, /\/v1\/albums\/collected/);
  assert.match(provider, /album_sublist: moduleCall\("album_sublist"\)/);
  assert.doesNotMatch(server, /album_sub:/);
});
