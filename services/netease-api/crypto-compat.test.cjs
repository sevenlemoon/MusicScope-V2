const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { generateKeyPairSync, privateDecrypt, constants } = require('node:crypto');
const { createRequire } = require('node:module');
const upstreamRoot = path.dirname(require.resolve('@neteasecloudmusicapienhanced/api'));
const upstreamRequire = createRequire(path.join(upstreamRoot, 'util/crypto.js'));
const adapter = upstreamRequire('node-forge');

test('pinned upstream weapi output matches the original forge implementation', () => {
  // Captured from the unmodified api@4.40.1 + node-forge@1.4.0 before replacing it.
  // All values are synthetic; fixed Math.random is only used for this fixture.
  const crypto = upstreamRequire('./crypto.js');
  const original = Math.random;
  Math.random = () => 0.25;
  try {
    assert.deepEqual(crypto.weapi({ id: 123456, quality: 'standard', label: '中文测试' }), {
      params: 'YF9E6IEyNHCmhdLWksoDmvkXqHMAgQgqpv/wDn/k6kmRCquA9WfY/VM1aK3VjL5lFDtJYb0KxQFY7lgTDBKYqpO9uLFJi5z6rqR+9AVol0gBBfX3xOBboDR/l3c/jQSi',
      encSecKey: 'd571259ee779c40016dcd8456ee76ec0668228ab9d7873275215adb6872bacc5ca4b6062b399303863af64e3999bf981fe2638edeb2a8fc791ac20edce7598b8fac0571dda6aea083a4ff651996a0deed7ce46756acb8716e86aab55a039746baee9b9ffe26081c588d450053a37b98ab01ee92677e139ac9370187593a64bc9',
    });
  } finally { Math.random = original; }
});

test('native adapter preserves binary data and fixed-width RSA encryption', () => {
  for (const modulusLength of [1024, 2048]) {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength });
    const key = adapter.pki.publicKeyFromPem(publicKey.export({ type: 'spki', format: 'pem' }));
    const plaintext = Buffer.from([0, 1, 127, 128, 255]);
    const ciphertext = Buffer.from(key.encrypt(plaintext.toString('latin1'), 'NONE'), 'latin1');
    assert.equal(ciphertext.length, modulusLength / 8);
    const restored = privateDecrypt({ key: privateKey, padding: constants.RSA_NO_PADDING }, ciphertext);
    assert.deepEqual(restored.subarray(-plaintext.length), plaintext);
    assert.ok(restored.subarray(0, -plaintext.length).every((byte) => byte === 0));
    assert.equal(adapter.util.bytesToHex(ciphertext), ciphertext.toString('hex'));
    assert.throws(() => key.encrypt('hello', 'RSAES-PKCS1-V1_5'), /Only/);
    assert.throws(() => key.encrypt('x'.repeat(modulusLength / 8 + 1), 'NONE'), /exceeds/);
    assert.throws(() => key.encrypt('中文', 'NONE'), /binary/);
    assert.equal(key.verify, undefined);
  }
  const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  assert.throws(() => adapter.pki.publicKeyFromPem(ec.publicKey.export({ type: 'spki', format: 'pem' })), /RSA/);
  assert.throws(() => adapter.pki.publicKeyFromPem('invalid PEM'));
});

test('upstream remains pinned to the reviewed encryption-only forge contract', () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(upstreamRoot, 'package.json')));
  assert.equal(metadata.version, '4.40.1', 'Re-review the adapter when upgrading the provider');
  const consumers = [];
  for (const file of fs.globSync('**/*.js', { cwd: upstreamRoot, exclude: ['node_modules/**'] })) {
    const source = fs.readFileSync(path.join(upstreamRoot, file), 'utf8');
    if (/require\(['"]node-forge['"]\)/.test(source)) consumers.push(file.replaceAll('\\', '/'));
  }
  assert.deepEqual(consumers, ['util/crypto.js']);
  const source = fs.readFileSync(path.join(upstreamRoot, 'util/crypto.js'), 'utf8');
  assert.deepEqual(source.match(/forge\.[\w.]+/g), ['forge.pki.publicKeyFromPem', 'forge.util.bytesToHex']);
  assert.equal(upstreamRequire('node-forge/package.json').name, '@musicscope/netease-rsa');
  assert.equal(fs.lstatSync(path.join(__dirname, 'node_modules/node-forge')).isSymbolicLink(), false,
    'Relocatable packages must install a physical adapter directory');
});
