// Restore notices omitted by Next's runtime-only file tracing, from the same install.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');

const noticeName = /^(?:licen[cs]es?|copying|notices?|copyright)(?:[._ -].*)?$/i;
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const portable = (file) => file.split(path.sep).join('/');

function contained(root, relative) {
  assert.ok(relative && !relative.includes('\\') && !relative.includes(':') &&
    !relative.startsWith('/') && !relative.split('/').some((part) => !part || part === '..' || part === '.'),
  `Invalid notice path: ${relative}`);
  const target = path.join(root, ...relative.split('/'));
  const resolved = path.relative(fs.realpathSync(root), fs.realpathSync(target));
  assert.ok(!resolved.startsWith('..') && !path.isAbsolute(resolved), 'Notice escaped the package');
  return target;
}

function collect(source, destination, manifest) {
  source = fs.realpathSync(source);
  destination = fs.realpathSync(destination);
  assert.notEqual(source, destination, 'Use a separate packaged directory');
  const notices = [];
  const packages = [];
  function visit(relative = '', noticeDirectory = false) {
    const original = path.join(source, relative);
    const packaged = path.join(destination, relative);
    assert.ok(fs.statSync(original).isDirectory(), `Missing source directory: ${relative}`);
    assert.ok(!fs.lstatSync(packaged).isSymbolicLink(), `Packaged symlink: ${relative}`);
    const metadata = path.join(packaged, 'package.json');
    if (!noticeDirectory && fs.existsSync(metadata)) {
      const actual = JSON.parse(fs.readFileSync(metadata, 'utf8'));
      const expected = JSON.parse(fs.readFileSync(path.join(original, 'package.json'), 'utf8'));
      assert.equal(actual.name, expected.name, `Package name mismatch: ${relative}`);
      assert.equal(actual.version, expected.version, `Package version mismatch: ${relative}`);
      packages.push({ path: portable(path.join(relative, 'package.json')), name: actual.name,
        version: actual.version, license: actual.license ?? null, sha256: digest(metadata) });
    }
    for (const entry of fs.readdirSync(original, { withFileTypes: true })) {
      const next = path.join(relative, entry.name);
      const target = path.join(destination, next);
      const isNotice = noticeDirectory || noticeName.test(entry.name);
      if (isNotice) {
        assert.ok(!entry.isSymbolicLink(), `Source notice symlink: ${next}`);
        if (fs.existsSync(target)) assert.ok(!fs.lstatSync(target).isSymbolicLink(), `Packaged symlink: ${next}`);
        if (entry.isDirectory()) {
          fs.mkdirSync(target, { recursive: true });
          visit(next, true);
        } else if (entry.isFile()) {
          fs.copyFileSync(path.join(source, next), target);
          notices.push({ path: portable(next), sha256: digest(target) });
        }
      } else if (entry.isDirectory() && fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        // Follow only directories represented in the shipped runtime, not unused/dev packages.
        visit(next);
      }
    }
  }
  visit();
  for (const name of ['next', 'react', 'react-dom']) {
    assert.ok(packages.some((item) => item.name === name), `Missing runtime package: ${name}`);
    assert.ok(notices.some((item) => item.path.startsWith(`${name}/`) &&
      !item.path.slice(name.length + 1).includes('/')), `Missing root notice: ${name}`);
  }
  const report = { schema_version: 1, scope: 'Notices present in the installed sources for shipped web directories; not a complete redistribution review.',
    packages: packages.sort((a, b) => a.path.localeCompare(b.path)),
    notices: notices.sort((a, b) => a.path.localeCompare(b.path)) };
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify(report, null, 2) + '\n');
  return report;
}

function verify(destination, manifest) {
  const report = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.equal(report.schema_version, 1);
  assert.ok(report.notices.length > 0 && report.packages.length > 0, 'Empty notice inventory');
  for (const item of [...report.packages, ...report.notices]) {
    assert.equal(digest(contained(destination, item.path)), item.sha256, `Changed notice or package: ${item.path}`);
  }
  return report;
}

if (require.main === module) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'collect' && args.length === 3) collect(...args);
  else if (mode === 'verify' && args.length === 2) verify(...args);
  else throw new Error('Usage: desktop_web_notices.cjs collect SOURCE_MODULES PACKAGED_MODULES MANIFEST | verify PACKAGED_MODULES MANIFEST');
  console.info('Packaged web notices: ' + mode + ' passed');
}
module.exports = { collect, verify };
