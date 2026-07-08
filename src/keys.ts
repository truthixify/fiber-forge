/**
 * CKB key generation and the fnn `ckb/key` encryption format.
 *
 * fnn requires a pre-existing encrypted CKB private key at `<base>/ckb/key`. The file layout is
 * `[version=0x00][salt:16][nonce:12][AES-256-GCM ciphertext]`, where the AES key is
 * `scrypt(password, salt, N=2^17, r=8, p=1, 32)` and the plaintext is the 32 raw private-key
 * bytes (see fnn `utils/encrypt_decrypt_file.rs`). The orchestrator generates a fresh key per node
 * and writes this exact format, so nodes never depend on the repo's committed test keys.
 */

import { gcm } from "@noble/ciphers/aes.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { randomBytes } from "node:crypto";

const VERSION = 0x00;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const PRIVATE_KEY_LEN = 32;

// fnn uses the scrypt crate's `Params::recommended()` = log_n 17, r 8, p 1, with a 32-byte key.
const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1, dkLen: 32 } as const;

function deriveAesKey(password: string, salt: Uint8Array): Uint8Array {
  return scrypt(new TextEncoder().encode(password), salt, SCRYPT_PARAMS);
}

/** A fresh 32-byte CKB secp256k1 private key. */
export function generatePrivateKey(): Uint8Array {
  return new Uint8Array(randomBytes(PRIVATE_KEY_LEN));
}

/** Encrypt a 32-byte CKB private key into the fnn `ckb/key` file format. */
export function encryptKey(
  privateKey: Uint8Array,
  password: string,
): Uint8Array {
  if (privateKey.length !== PRIVATE_KEY_LEN) {
    throw new Error(`private key must be ${PRIVATE_KEY_LEN} bytes`);
  }
  const salt = new Uint8Array(randomBytes(SALT_LEN));
  const nonce = new Uint8Array(randomBytes(NONCE_LEN));
  const ciphertext = gcm(deriveAesKey(password, salt), nonce).encrypt(
    privateKey,
  );
  const file = new Uint8Array(1 + SALT_LEN + NONCE_LEN + ciphertext.length);
  file[0] = VERSION;
  file.set(salt, 1);
  file.set(nonce, 1 + SALT_LEN);
  file.set(ciphertext, 1 + SALT_LEN + NONCE_LEN);
  return file;
}

/** Decrypt an fnn `ckb/key` file back to the 32-byte private key. */
export function decryptKey(file: Uint8Array, password: string): Uint8Array {
  if (file.length < 1 + SALT_LEN + NONCE_LEN + 16 || file[0] !== VERSION) {
    throw new Error("not a valid encrypted key file");
  }
  const salt = file.subarray(1, 1 + SALT_LEN);
  const nonce = file.subarray(1 + SALT_LEN, 1 + SALT_LEN + NONCE_LEN);
  const ciphertext = file.subarray(1 + SALT_LEN + NONCE_LEN);
  return gcm(deriveAesKey(password, salt), nonce).decrypt(ciphertext);
}
