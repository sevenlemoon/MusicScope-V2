const { createPublicKey, publicEncrypt, constants } = require('node:crypto');

// This is deliberately NOT a general forge implementation. The pinned upstream
// client only encrypts the reversed 16-byte weapi secret using its public key.
// No forge source, ASN.1 signature parser, verification, or private-key API is shipped.
function publicKeyFromPem(pem) {
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'rsa') throw new TypeError('NetEase requires an RSA public key');
  const size = Math.ceil(key.asymmetricKeyDetails.modulusLength / 8);
  return Object.freeze({
    encrypt(input, scheme) {
      if (scheme !== 'NONE') throw new TypeError('Only the NetEase raw RSA encryption scheme is supported');
      if (typeof input !== 'string' || /[^\x00-\xff]/u.test(input)) {
        throw new TypeError('Expected a binary string');
      }
      const bytes = Buffer.from(input, 'latin1');
      if (bytes.length > size) throw new RangeError('RSA input exceeds the modulus size');
      // forge NONE left-pads the message integer to the modulus width. Node's
      // OpenSSL implementation requires that width explicitly for RSA_NO_PADDING.
      const padded = Buffer.alloc(size);
      bytes.copy(padded, size - bytes.length);
      return publicEncrypt({ key, padding: constants.RSA_NO_PADDING }, padded).toString('latin1');
    },
  });
}

module.exports = Object.freeze({
  pki: Object.freeze({ publicKeyFromPem }),
  util: Object.freeze({ bytesToHex: (bytes) => Buffer.from(bytes, 'latin1').toString('hex') }),
});
