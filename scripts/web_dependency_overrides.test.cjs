const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const webRequire = createRequire(path.join(__dirname, '../apps/web/package.json'));
const pluginPath = webRequire.resolve('@next/eslint-plugin-next');
const pluginRequire = createRequire(pluginPath);
const { getRootDirs } = pluginRequire('./utils/get-root-dirs.js');

test('Next lint resolves directory globs through tinyglobby without braces', () => {
  assert.equal(pluginRequire('fast-glob/package.json').name, 'tinyglobby');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'MusicScope glob '));
  try {
    for (const name of ['web', 'admin', '中文 app']) fs.mkdirSync(path.join(root, name));
    fs.writeFileSync(path.join(root, 'not-a-directory'), 'test');
    const portable = (value) => value.replaceAll('\\', '/');
    const context = (rootDir) => ({ cwd: root, settings: { next: { rootDir } } });
    // tinyglobby returns cwd-relative directory names with a trailing slash.
    // Next joins these with pages/app and uses fs; both representations must
    // resolve to the same directories, including absolute rootDir patterns.
    const resolved = (values) => values.map((value) => path.resolve(value)).sort();
    assert.deepEqual(getRootDirs(context(undefined)), [root]);
    assert.deepEqual(resolved(getRootDirs(context(portable(path.join(root, '{web,admin}'))))),
      ['admin', 'web'].map((name) => path.join(root, name)).sort());
    assert.deepEqual(resolved(getRootDirs(context([portable(path.join(root, '中文 app')), portable(path.join(root, 'missing*'))]))),
      [path.join(root, '中文 app')]);
    assert.equal(getRootDirs(context(portable(path.join(root, '*')))).length, 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('deep nested brace patterns do not overflow the replacement glob parser', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'MusicScope deep glob '));
  try {
    // Run the advisory's deeply nested shape in a bounded child process.
    const source = `const req = require('node:module').createRequire(${JSON.stringify(pluginPath)});
      const glob = req('fast-glob').globSync;
      const matches = glob('{'.repeat(10000) + 'a,b' + '}'.repeat(10000), {onlyDirectories:true});
      if (matches.length !== 0) process.exit(2);`;
    const result = spawnSync(process.execPath, ['-e', source], { cwd: root, timeout: 15000, encoding: 'utf8' });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Next still reports forbidden HTML page links when rootDir is a glob', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'MusicScope lint '));
  try {
    const pages = path.join(root, 'web', 'pages');
    fs.mkdirSync(pages, { recursive: true });
    fs.writeFileSync(path.join(pages, 'about.js'), 'export default function About() {}');
    const { Linter } = webRequire('eslint');
    const rule = '@next/next/no-html-link-for-pages';
    const messages = new Linter().verify('<a href="/about">About</a>', [{
      files: ['**/*.jsx'],
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { '@next/next': webRequire('@next/eslint-plugin-next') },
      settings: { next: { rootDir: path.join(root, '*').replaceAll('\\', '/') } },
      rules: { [rule]: 'error' },
    }], { filename: 'page.jsx' });
    assert.ok(messages.some((message) => message.ruleId === rule), JSON.stringify(messages));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
