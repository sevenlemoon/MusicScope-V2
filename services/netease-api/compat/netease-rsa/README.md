# NetEase RSA compatibility adapter

This **original encryption-only implementation** replaces `node-forge` for
`@neteasecloudmusicapienhanced/api@4.40.1`. That pinned client's `util/crypto.js`
only calls `pki.publicKeyFromPem`, `encrypt(value, 'NONE')`, and `util.bytesToHex`.
The RSA operation is performed by Node's maintained `node:crypto` / OpenSSL,
with the left zero padding required by the existing weapi protocol.

This package contains no node-forge source and does not implement signature
verification. In particular, the vulnerable ASN.1 verification path from
[GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)
is absent, rather than ignored by an audit exception. The `node-forge` import
name is retained only as an npm override so the pinned client can call this
limited interface without a postinstall source rewrite.

Do not use raw RSA encryption in new protocols. This adapter exists solely for
compatibility with the provider's existing protocol. Unsupported schemes fail
explicitly. Tests cover the original upstream weapi output, private-key round
trips, invalid inputs, and upstream usage. Review those tests before updating
the upstream client. Packagers must copy this directory before `npm ci`.
