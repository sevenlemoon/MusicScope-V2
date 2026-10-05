const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collect, verify } = require('./desktop_web_notices.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'MusicScope notices 用户 '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const packaged = path.join(root, 'relocated');
  const manifest = path.join(root, 'inventory', 'web-notices.json');
  const write = (base, file, data) => {
    const target = path.join(base, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  };
  for (const name of ['next', 'react', 'react-dom', 'unused-dev-tool']) {
    const metadata = JSON.stringify({ name, version: '1.0.0', license: 'MIT' });
    write(source, `${name}/package.json`, metadata);
    write(source, `${name}/LICENSE`, 'Original copyright and permission text\n');
    if (name !== 'unused-dev-tool') write(packaged, `${name}/package.json`, metadata);
  }
  write(source, 'next/dist/compiled/vendor/index.js', 'module.exports = {};');
  write(packaged, 'next/dist/compiled/vendor/index.js', 'module.exports = {};');
  write(source, 'next/dist/compiled/vendor/LICENSE.txt', 'Bundled vendor copyright\n');
  write(source, 'next/dist/compiled/vendor/licenses/third-party.txt', 'Nested notice\n');
  return { source, packaged, manifest, write };
}

test('standalone root and vendored notices survive relocation without copying dev code', (t) => {
  const { source, packaged, manifest } = fixture(t);
  const report = collect(source, packaged, manifest);
  assert.equal(report.notices.length, 5);
  assert.equal(report.packages.length, 3);
  assert.equal(fs.existsSync(path.join(packaged, 'unused-dev-tool')), false);
  for (const item of report.notices) assert.deepEqual(fs.readFileSync(path.join(packaged, item.path)), fs.readFileSync(path.join(source, item.path)));
  fs.rmSync(source, { recursive: true });
  assert.deepEqual(verify(packaged, manifest), report);
});

test('a stale source install cannot supply notices for another runtime version', (t) => {
  const { source, packaged, manifest, write } = fixture(t);
  write(packaged, 'next/package.json', JSON.stringify({ name: 'next', version: '2.0.0' }));
  assert.throws(() => collect(source, packaged, manifest), /version mismatch/);
});

test('missing required source notices and changed packaged notices fail verification', (t) => {
  const { source, packaged, manifest, write } = fixture(t);
  fs.unlinkSync(path.join(source, 'react/LICENSE'));
  assert.throws(() => collect(source, packaged, manifest), /Missing root notice: react/);
  write(source, 'react/LICENSE', 'Restored notice');
  collect(source, packaged, manifest);
  write(packaged, 'react/LICENSE', 'Truncated');
  assert.throws(() => verify(packaged, manifest), /Changed notice/);
});

test('inventory paths cannot escape the extracted package', (t) => {
  const { source, packaged, manifest } = fixture(t);
  const report = collect(source, packaged, manifest);
  report.notices[0].path = '../outside.txt';
  fs.writeFileSync(manifest, JSON.stringify(report));
  assert.throws(() => verify(packaged, manifest), /Invalid notice path/);
});
