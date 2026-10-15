const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fingerprint, acquireLock, serviceProcessBelongsToInstall, serviceProcessBelongsToWorker } = require('./mac_launcher.cjs');

test('only the exact production listeners are eligible for automatic cleanup', () => {
  const root = path.resolve(__dirname, '..');
  assert.equal(serviceProcessBelongsToInstall('web', {
    command: 'next-server (v16.3.8)', cwd: path.join(root, '.tools/mac/web'),
  }), true);
  assert.equal(serviceProcessBelongsToInstall('web', {
    command: 'next dev --hostname 127.0.0.1 --port 3100', cwd: path.join(root, 'apps/web'),
  }), false);
  assert.equal(serviceProcessBelongsToInstall('web', {
    command: 'python unrelated_server.py', cwd: root,
  }), false);
  assert.equal(serviceProcessBelongsToInstall('api', {
    command: 'Python -m uvicorn app.main:app --host 127.0.0.1', cwd: path.join(root, 'apps/api'),
  }), true);
  assert.equal(serviceProcessBelongsToInstall('api', {
    command: 'Python -m http.server 8100', cwd: path.join(root, 'apps/api'),
  }), false);
  assert.equal(serviceProcessBelongsToWorker({
    command: 'Python -m audio_worker --health-file worker.json', cwd: path.join(root, 'apps/audio-worker'),
  }), true);
  assert.equal(serviceProcessBelongsToWorker({
    command: 'Python -m audio_worker', cwd: path.join(root, 'apps/api'),
  }), false);
});

test('production cache invalidates changed content even when timestamps are unchanged', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'MusicScope cache '));
  try {
    const source = path.join(temp, 'component.tsx');
    fs.writeFileSync(source, 'old');
    const first = fingerprint(temp);
    const times = fs.statSync(source);
    fs.writeFileSync(source, 'new');
    fs.utimesSync(source, times.atime, times.mtime);
    assert.notEqual(fingerprint(temp), first);
    fs.mkdirSync(path.join(temp, 'node_modules'));
    const beforeDependencies = fingerprint(temp, new Set(['node_modules']));
    fs.writeFileSync(path.join(temp, 'node_modules', 'ignored.js'), 'ignore');
    assert.equal(fingerprint(temp, new Set(['node_modules'])), beforeDependencies);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('another launcher cannot take over a live profile or clear its lock', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'MusicScope lock '));
  try {
    const file = path.join(temp, 'lock');
    const release = acquireLock(file);
    assert.throws(() => acquireLock(file), /已在运行/);
    assert.equal(JSON.parse(fs.readFileSync(file)).pid, process.pid);
    release();
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('status on a new profile does not create a directory or run setup', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'MusicScope status '));
  const data = path.join(temp, '用户资料');
  try {
    const result = spawnSync(process.execPath, [path.join(__dirname, 'mac_launcher.cjs'), '--status'], {
      env: { ...process.env, MUSICSCOPE_DATA_DIR: data }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /未运行/);
    assert.equal(fs.existsSync(data), false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
