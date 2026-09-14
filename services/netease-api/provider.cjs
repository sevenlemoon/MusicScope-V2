const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { AsyncLocalStorage } = require("node:async_hooks");

// The upstream client prints full error objects, including response cookies.
// Keep all provider-internal diagnostics inside a suppressed async context;
// server.cjs emits only MusicScope's safe category/timing records.
const providerLogContext = new AsyncLocalStorage();
for (const level of ["log", "warn", "error"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    if (!providerLogContext.getStore()?.suppress) original(...args);
  };
}

const anonymousTokenPath = path.join(os.tmpdir(), "anonymous_token");
if (!fs.existsSync(anonymousTokenPath)) fs.writeFileSync(anonymousTokenPath, "", { mode: 0o600 });

const packageRoot = path.dirname(require.resolve("@neteasecloudmusicapienhanced/api"));
const request = require(path.join(packageRoot, "util/request.js"));
const { cookieToJson } = require(path.join(packageRoot, "util/index.js"));
const generateConfig = require(path.join(packageRoot, "generateConfig.js"));
const xeapiPublicKeyPath = path.join(os.tmpdir(), "xeapi_public_key");
let xeapiConfiguration;

function moduleCall(name) {
  const operation = require(path.join(packageRoot, `module/${name}.js`));
  return (data = {}) => providerLogContext.run({ suppress: true }, () => operation(
    {
      ...data,
      cookie: typeof data.cookie === "string" ? cookieToJson(data.cookie) : data.cookie || {},
    },
    request,
  ));
}

function ensureXeapiConfiguration() {
  if (!fs.existsSync(xeapiPublicKeyPath)) {
    xeapiConfiguration ||= providerLogContext.run({ suppress: true }, () => generateConfig());
    return xeapiConfiguration;
  }
  return Promise.resolve();
}

const songUrlV1 = moduleCall("song_url_v1");

module.exports = {
  login_qr_key: moduleCall("login_qr_key"),
  login_qr_create: moduleCall("login_qr_create"),
  login_qr_check: moduleCall("login_qr_check"),
  user_account: moduleCall("user_account"),
  user_playlist: moduleCall("user_playlist"),
  playlist_detail: moduleCall("playlist_detail"),
  song_detail: moduleCall("song_detail"),
  song_url_v1: async (data) => {
    await ensureXeapiConfiguration();
    return songUrlV1(data);
  },
  artist_detail: moduleCall("artist_detail"),
  album: moduleCall("album"),
};
