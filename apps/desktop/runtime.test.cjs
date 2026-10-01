const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { runtimePaths, runtimeEnvironment, assertFreePort } = require('./runtime.cjs');

test('production environment isolates data and ignores host Python/database settings', () => {
  const project = path.resolve('发布包 with spaces');
  const data = path.resolve('用户资料');
  const env = runtimeEnvironment(project, data, {
    Path: '/host/bin', PYTHONHOME: '/bad', PYTHONPATH: '/bad', VIRTUAL_ENV: '/bad',
    DATABASE_URL: 'postgresql://wrong', SECRET_ENCRYPTION_KEY: 'must-not-leak',
    NODE_OPTIONS: '--require malicious.js', UV_PROJECT_ENVIRONMENT: '/bad',
  });
  assert.equal(env.MUSICSCOPE_DATA_DIR, data);
  assert.equal(env.DATABASE_URL, 'sqlite+pysqlite:///' + path.join(data, 'storage/library.sqlite3').replaceAll('\\', '/'));
  assert.equal(env.AUDIO_STORAGE_DIR, path.join(data, 'storage/audio'));
  assert.equal(env.NODE_ENV, 'production');
  for (const key of ['Path', 'PYTHONHOME', 'PYTHONPATH', 'VIRTUAL_ENV', 'NODE_OPTIONS', 'UV_PROJECT_ENVIRONMENT', 'SECRET_ENCRYPTION_KEY']) assert.equal(env[key], undefined);
  assert.ok(env.PATH.startsWith(path.join(project, 'runtime/ffmpeg/bin')));
});

test('missing bundled dependencies fail explicitly, without invoking a downloader', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'musicscope-package-test-'));
  try { assert.throws(() => runtimePaths(directory), /安装包缺少 python/); }
  finally { fs.rmSync(directory, { recursive: true }); }
});

test('occupied service ports are rejected rather than reused or killed', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await assert.rejects(assertFreePort(server.address().port), /已被占用/); }
  finally { await new Promise((resolve) => server.close(resolve)); }
});

test('desktop path has no development launcher or smoke-only deployment bypass', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const runtime = fs.readFileSync(path.join(__dirname, 'runtime.cjs'), 'utf8');
  assert.doesNotMatch(main, /dev\.ps1|cpSync|smoke\s*\?\s*source/);
  assert.doesNotMatch(runtime, /npm\.cmd|uv sync|powershell\.exe/);
  assert.match(main, /MUSICSCOPE_SMOKE_DATA_DIR/);
});
