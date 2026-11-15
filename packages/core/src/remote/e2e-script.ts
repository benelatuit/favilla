/**
 * The phone's primitives in script, for a page that has no WebCrypto: one opened from the computer over the local
 * network (a plain http:// address) is not a secure context. The same algorithms and the same byte forms as WebCrypto,
 * so the computer cannot tell which side the phone used. The page loads this only when it needs it.
 */
import { gcm } from '@noble/ciphers/aes.js';
import { p256 } from '@noble/curves/nist.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { AgreeKey, Primitives, RawKey } from './e2e';

/** A fresh copy on its own ArrayBuffer, the type WebCrypto's callers expect. */
const own = (u: Uint8Array): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(u.length));
  out.set(u);
  return out;
};

function raw(key: AgreeKey): Uint8Array {
  const r = (key as RawKey).raw;
  if (!(r instanceof Uint8Array)) throw new Error('a key made by WebCrypto, not by these primitives');
  return r;
}

export const scriptPrimitives: Primitives = {
  async newAgreementKey() {
    const secret = p256.utils.randomSecretKey();
    return { privateKey: { raw: secret }, publicKey: { raw: p256.getPublicKey(secret, false) } };
  },
  async rawPublic(key) {
    return own(raw(key));
  },
  async dh(priv, pub) {
    // The compressed shared point without its sign byte is the x coordinate, what WebCrypto's deriveBits returns.
    return own(p256.getSharedSecret(raw(priv), pub, true).subarray(1));
  },
  async sha256(data) {
    return own(sha256(data));
  },
  async hmac(key, data) {
    return own(hmac(sha256, key, data));
  },
  async hkdf(ikm, salt, info, bytes) {
    return own(hkdf(sha256, ikm, salt, info, bytes));
  },
  async aesGcm(key) {
    const k = own(key);
    return {
      seal: async (iv, aad, plain) => own(gcm(k, iv, aad).encrypt(plain)),
      open: async (iv, aad, sealed) => own(gcm(k, iv, aad).decrypt(sealed)),
    };
  },
};
