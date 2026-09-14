const http = require("node:http");
const crypto = require("node:crypto");
const api = require("./provider.cjs");

const HOST = "127.0.0.1";
const PORT = Number(process.env.MUSICSCOPE_NETEASE_PORT || "36531");
const MAX_BODY_BYTES = 1024 * 1024;
const QR_TTL_MS = 5 * 60 * 1000;
const challenges = new Map();
const PLAYBACK_LEVELS = new Set(["standard", "exhigh", "lossless", "hires"]);

function bodyOf(result) {
  return result && typeof result === "object" && "body" in result ? result.body : result;
}

function mergeCookies(...values) {
  const cookies = new Map();
  for (const value of values.flat(Infinity)) {
    for (const part of String(value || "").split(";")) {
      const trimmed = part.trim();
      const separator = trimmed.indexOf("=");
      if (separator > 0) cookies.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
    }
  }
  return [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
}

async function readJson(request) {
  let total = 0;
  const chunks = [];
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("request_too_large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(response, status, payload) {
  const encoded = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": encoded.length,
    "cache-control": "no-store",
  });
  response.end(encoded);
}

function requireText(payload, name) {
  const value = payload[name];
  if (typeof value !== "string" || !value.trim()) throw new Error(`missing_${name}`);
  return value;
}

async function callProvider(category, operation) {
  const started = performance.now();
  try {
    const result = await operation();
    console.info(JSON.stringify({ category, classification: "success", duration_ms: Math.round(performance.now() - started) }));
    return result;
  } catch (error) {
    console.error(JSON.stringify({
      category,
      classification: "provider_error",
      provider_status: Number(error.status || error.statusCode || (error.body && error.body.code)) || null,
      error_type: error && error.constructor ? error.constructor.name : "Error",
      duration_ms: Math.round(performance.now() - started),
    }));
    throw error;
  }
}

async function createQr(payload) {
  const publicId = requireText(payload, "challenge_id");
  const keyResult = await callProvider("qr_key", () => api.login_qr_key({ timestamp: Date.now() }));
  const keyBody = bodyOf(keyResult) || {};
  const providerKey = keyBody.data && (keyBody.data.unikey || keyBody.data.key);
  if (!providerKey) throw new Error("provider_qr_key_missing");
  const createResult = await callProvider("qr_create", () => api.login_qr_create({ key: providerKey, qrimg: true }));
  const createBody = bodyOf(createResult) || {};
  const qrData = createBody.data || {};
  challenges.set(publicId, {
    providerKey,
    cookie: mergeCookies(keyResult.cookie || []),
    expiresAt: Date.now() + QR_TTL_MS,
  });
  return {
    challenge_id: publicId,
    qr_url: qrData.qrurl,
    qr_image_data_url: qrData.qrimg,
    expires_at: new Date(Date.now() + QR_TTL_MS).toISOString(),
  };
}

async function checkQr(payload) {
  const publicId = requireText(payload, "challenge_id");
  const challenge = challenges.get(publicId);
  if (!challenge || challenge.expiresAt <= Date.now()) {
    challenges.delete(publicId);
    return { code: 800 };
  }
  const result = await callProvider("qr_check", () => api.login_qr_check({
    key: challenge.providerKey,
    cookie: challenge.cookie,
    timestamp: Date.now(),
  }));
  const body = bodyOf(result) || {};
  const code = Number(body.code);
  if (![800, 801, 802, 803].includes(code)) throw new Error("provider_qr_status_unknown");
  if (code === 800) challenges.delete(publicId);
  if (code !== 803) return { code };

  const sessionCookie = mergeCookies(challenge.cookie, result.cookie || [], body.cookie || "");
  challenges.delete(publicId);
  if (!sessionCookie) throw new Error("provider_session_missing");
  return { code, session_cookie: sessionCookie };
}

async function providerRead(payload, operation, category) {
  const session = requireText(payload, "session_cookie");
  const result = await callProvider(category, () => operation({ ...payload, cookie: session, timestamp: Date.now() }));
  const body = bodyOf(result) || {};
  if (Number(body.code) === 301) {
    const error = new Error("provider_session_expired");
    error.statusCode = 401;
    throw error;
  }
  return body;
}

async function playbackSource(payload) {
  const id = requireText(payload, "id");
  const level = requireText(payload, "level");
  if (!PLAYBACK_LEVELS.has(level)) throw new Error("invalid_playback_level");
  return providerRead(
    { session_cookie: payload.session_cookie, id, level },
    api.song_url_v1,
    "playback_source",
  );
}

async function artistDetail(payload) {
  try {
    return await providerRead(payload, api.artist_detail, "artist_detail");
  } catch (error) {
    const providerStatus = Number(error.status || error.statusCode || (error.body && error.body.code));
    if (providerStatus === 404) return { code: 404, artist: null };
    throw error;
  }
}

async function route(request, response) {
  if (request.method === "GET" && request.url === "/health") return send(response, 200, { status: "ok" });
  if (request.method !== "POST") return send(response, 404, { code: "not_found" });
  const payload = await readJson(request);
  const path = request.url;
  if (path === "/v1/qr/create") return send(response, 200, await createQr(payload));
  if (path === "/v1/qr/check") return send(response, 200, await checkQr(payload));
  if (path === "/v1/qr/cancel") {
    challenges.delete(requireText(payload, "challenge_id"));
    return send(response, 200, { status: "cancelled" });
  }
  if (path === "/v1/account") return send(response, 200, await providerRead(payload, api.user_account, "account"));
  if (path === "/v1/playlists") return send(response, 200, await providerRead(payload, api.user_playlist, "playlists"));
  if (path === "/v1/playlist/detail") return send(response, 200, await providerRead(payload, api.playlist_detail, "playlist_detail"));
  if (path === "/v1/songs/detail") return send(response, 200, await providerRead(payload, api.song_detail, "song_detail"));
  if (path === "/v1/song/url") return send(response, 200, await playbackSource(payload));
  if (path === "/v1/artist/detail") return send(response, 200, await artistDetail(payload));
  if (path === "/v1/album/detail") return send(response, 200, await providerRead(payload, api.album, "album_detail"));
  return send(response, 404, { code: "not_found" });
}

const server = http.createServer((request, response) => {
  const requestId = crypto.randomUUID();
  route(request, response).catch((error) => {
    const status = Number(error.statusCode) || 502;
    console.error(JSON.stringify({ request_id: requestId, classification: status === 401 ? "authentication_expired" : "sidecar_error" }));
    if (!response.headersSent) send(response, status, { code: status === 401 ? "authentication_expired" : "provider_unavailable" });
    else response.end();
  });
});

server.listen(PORT, HOST, () => {
  console.info(JSON.stringify({ service: "musicscope-netease-sidecar", host: HOST, port: PORT }));
});
