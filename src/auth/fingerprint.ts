/**
 * Machine-fingerprint-bound encrypted file fallback (§5.2 优先级 2).
 *
 * When OS keychain is unavailable, credentials are encrypted with a key
 * derived from the machine UUID (node-machine-id) via scrypt, then
 * AES-256-GCM. File format: [12B nonce][16B tag][ciphertext...].
 *
 * GCM standard nonce is 96 bits (12 bytes) — not 16. The tag is 16 bytes
 * (128-bit authentication tag).
 *
 * Threat model (§5.2): same-user-same-machine is trusted. The machine UUID
 * is OS-level; VM cloning copies it — a known limitation, not a security
 * hole (we don't defend against same-machine cloning). The key never
 * touches disk; the ciphertext is useless on a different machine.
 */

import { createDecipheriv, createCipheriv, randomBytes, scryptSync } from "node:crypto";
// node-machine-id is CJS with no named ESM exports — import the default.
import machineIdModule from "node-machine-id";
const machineIdSync: () => string = machineIdModule.machineIdSync;

const SALT = "huaweicloud-ops-deploy/credentials/v1";
const KEY_LEN = 32; // AES-256
const NONCE_LEN = 12; // GCM standard (96-bit nonce)
const TAG_LEN = 16; // 128-bit auth tag

/** Derive a 32-byte key from the machine UUID via scrypt. */
function deriveKey(): Buffer {
  const machineId = machineIdSync();
  return scryptSync(machineId, SALT, KEY_LEN);
}

/** Encrypt plaintext → [nonce][tag][ciphertext] as a Buffer. */
export async function fingerprintEncrypt(plaintext: string): Promise<Buffer> {
  const key = deriveKey();
  const nonce = randomBytes(NONCE_LEN);

  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: [nonce (12)][tag (16)][ciphertext]
  return Buffer.concat([nonce, tag, ciphertext]);
}

/** Decrypt [nonce][tag][ciphertext] → plaintext. Throws on tamper/wrong machine. */
export async function fingerprintDecrypt(data: Buffer): Promise<string> {
  if (data.length < NONCE_LEN + TAG_LEN) {
    throw new Error("credentials file corrupted (too short)");
  }
  const key = deriveKey();
  const nonce = data.subarray(0, NONCE_LEN);
  const tag = data.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
  const ciphertext = data.subarray(NONCE_LEN + TAG_LEN);

  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
