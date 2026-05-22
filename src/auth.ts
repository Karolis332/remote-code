/**
 * Pairing + authorization for the Telegram daemon.
 *
 * Pairing flow:
 *  1. Daemon boots, calls getOrIssuePairingCode → 6-char code persisted in
 *     meta_kv['pairing_code'] until consumed.
 *  2. Operator messages bot from their phone: `/pair <code>`.
 *  3. consumePairingCode validates the code, writes the chat_id into the
 *     `auth` table, clears meta_kv['pairing_code'].
 *
 * After pairing, isAuthorized returns true for that chat_id. Env-allowed
 * chat ids bypass the pairing flow entirely.
 *
 * Security note: the pairing code is shown ONCE on daemon stdout at boot.
 * Anyone with physical access to that terminal can pair. This matches the
 * BYOK/local-only threat model in docs/ARCHITECTURE.md.
 */

import { randomInt } from "node:crypto";
import {
  type DB,
  getMeta,
  isPaired,
  pair,
  setMeta,
} from "./db/index.js";

const META_KEY = "pairing_code";
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/1/I/O
const CODE_LEN = 6;
const SENTINEL_CONSUMED = ""; // used to mark "no pending code"

function generateCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LEN; i++) {
    const idx = randomInt(0, CODE_ALPHABET.length);
    out += CODE_ALPHABET.charAt(idx);
  }
  return out;
}

/**
 * Return the currently pending pairing code, generating a new one if none
 * exists. Idempotent: calling twice without a successful consume returns the
 * same code. Once consumed (or cleared via clearPairingCode), the next call
 * issues a fresh code.
 */
export function getOrIssuePairingCode(db: DB): string {
  const existing = getMeta(db, META_KEY);
  if (existing !== null && existing !== SENTINEL_CONSUMED) {
    return existing;
  }
  const code = generateCode();
  setMeta(db, META_KEY, code);
  return code;
}

/**
 * Consume the pending pairing code by binding it to a chat_id. Returns true
 * on success, false if the code is wrong, expired, or already consumed.
 *
 * On success: writes the chat_id into the `auth` table and clears the
 * pairing code so it cannot be reused.
 */
export function consumePairingCode(
  db: DB,
  code: string,
  chat_id: number,
  label?: string,
): boolean {
  const stored = getMeta(db, META_KEY);
  if (stored === null || stored === SENTINEL_CONSUMED) return false;
  // Constant-time comparison would be overkill (the code is short and the
  // operator controls the channel); a normal equality check is sufficient.
  if (typeof code !== "string" || code.trim().toUpperCase() !== stored.trim().toUpperCase()) {
    return false;
  }
  pair(db, chat_id, label);
  setMeta(db, META_KEY, SENTINEL_CONSUMED);
  return true;
}

/** Explicit clear, useful for tests and for `/unpair`-style flows later. */
export function clearPairingCode(db: DB): void {
  setMeta(db, META_KEY, SENTINEL_CONSUMED);
}

/**
 * True iff chat_id is whitelisted via env ALLOWED_CHAT_IDS OR has been paired
 * via consumePairingCode.
 */
export function isAuthorized(
  db: DB,
  chat_id: number,
  envAllowed: number[],
): boolean {
  if (envAllowed.includes(chat_id)) return true;
  return isPaired(db, chat_id);
}
