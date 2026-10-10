const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fingerprint, acquireLock } = require('./mac_launcher.cjs');

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
