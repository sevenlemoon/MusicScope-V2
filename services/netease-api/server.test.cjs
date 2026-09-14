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
