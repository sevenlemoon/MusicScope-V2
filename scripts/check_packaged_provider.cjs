// Invoke using the relocated package's bundled Node, with developer tools off PATH.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const sidecar = path.resolve(process.argv[2]);
const packagedRequire = createRequire(path.join(sidecar, 'provider.cjs'));
const resolved = fs.realpathSync(packagedRequire.resolve('node-forge'));
const relative = path.relative(fs.realpathSync(sidecar), resolved);
assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), 'Adapter escaped the relocated package');
assert.equal(fs.lstatSync(path.join(sidecar, 'node_modules/node-forge')).isSymbolicLink(), false);
assert.equal(packagedRequire('node-forge/package.json').name, '@musicscope/netease-rsa');
const upstream = path.dirname(packagedRequire.resolve('@neteasecloudmusicapienhanced/api'));
const encrypted = packagedRequire(path.join(upstream, 'util/crypto.js')).weapi({ probe: true });
assert.match(encrypted.encSecKey, /^[a-f0-9]{256}$/);
assert.equal(typeof packagedRequire('./provider.cjs').login_qr_key, 'function');
console.info('Packaged NetEase native RSA adapter: passed');
