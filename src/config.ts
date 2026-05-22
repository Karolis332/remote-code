/**
 * Daemon configuration loader.
 *
 * Reads `.env` via dotenv and validates `process.env` through a zod schema.
 * Throws a clear, human-readable error if `TELEGRAM_BOT_TOKEN` is missing.
 */

import "dotenv/config";
import { z } from "zod";

export const Config = z.object({
  TELEGRAM_BOT_TOKEN: z
    .string()
    .min(40, "Set TELEGRAM_BOT_TOKEN from @BotFather"),
  ALLOWED_CHAT_IDS: z.string().default(""), // comma-separated
  PAIRING_CODE: z.string().optional(),
  CLAUDE_BIN: z.string().default("claude"),
  REMOTECODE_DB: z.string().optional(),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error"])
    .default("info"),
});

export type Config = z.infer<typeof Config>;

/** Parse the allowed-chat-ids string into a deduped list of ints. */
export function parseAllowedChatIds(raw: string): number[] {
  if (!raw) return [];
  const out: number[] = [];
  for (const tok of raw.split(",")) {
    const t = tok.trim();
    if (!t) continue;
    const n = Number(t);
    if (Number.isInteger(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

export function loadConfig(): Config {
  const result = Config.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Invalid configuration. Check your .env (see .env.example):\n${issues}`,
    );
  }
  return result.data;
}
