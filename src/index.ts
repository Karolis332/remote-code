/**
 * RemoteCode daemon entry point.
 *
 * Boots in this order:
 *   1. loadConfig() — env validation. Hard-fails if TELEGRAM_BOT_TOKEN absent.
 *   2. openDB + migrate — SQLite handle is opened, schema applied (idempotent).
 *   3. probeCli() — verifies `claude` CLI is installed and authenticated.
 *   4. getOrIssuePairingCode — printed once to stdout for first-run pairing.
 *   5. buildBot + launch — Telegraf long-poll starts; SIGINT/SIGTERM bound.
 *
 * Telegraf launch / stop docs: https://telegraf.js.org/.
 */

import pino from "pino";

import { loadConfig } from "./config.js";
import { migrate, openDB } from "./db/index.js";
import { probeCli } from "./claude-runner.js";
import { getOrIssuePairingCode } from "./auth.js";
import { buildBot } from "./bot.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.LOG_LEVEL });

  const db = openDB(config.REMOTECODE_DB);
  migrate(db);

  // The runner reads CLAUDE_BIN from process.env; loadConfig already
  // exported it into the process environment (or defaulted to "claude").
  const probe = await probeCli();
  if (!probe.installed) {
    logger.error(
      { probe },
      "claude CLI not detected - install from https://claude.com/code",
    );
    process.exit(1);
  }
  logger.info(
    { version: probe.version, authed: probe.authed },
    "claude CLI ready",
  );

  // First-run pairing code (shown until consumed).
  const code = getOrIssuePairingCode(db);
  // Pairing code is printed exactly once at boot, then redacted in all
  // subsequent logs (see logger.info below).
  logger.info(
    { pairing_code: code },
    `-> message your bot: /pair ${code}`,
  );

  const bot = buildBot({ db, config, logger });

  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));

  await bot.launch();
  logger.info("RemoteCode daemon online - awaiting commands");
}

main().catch((e) => {
  // No logger yet (or config failed); use raw stderr.
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
