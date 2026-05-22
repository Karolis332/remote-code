/**
 * Telegram bot wiring for the RemoteCode daemon.
 *
 * Telegraf v4 docs: https://telegraf.js.org/ (constructor / .command / .start /
 * .help / .catch / .launch / .stop). Message-edit streaming for /run uses
 * `ctx.telegram.editMessageText` (Telegram Bot API:
 *  https://core.telegram.org/bots/api#editmessagetext).
 *
 * Critical handler rules (per brief):
 *  - EVERY handler calls isAuthorized first; silently drop if false. We do
 *    NOT reply to unauthorized chats — that would leak the bot's existence.
 *  - Long replies are paginated at 4096 chars (Telegram Bot API limit).
 *  - User-provided strings are escaped before being inserted into Markdown.
 *  - All handler errors are caught + logged via pino; the user sees a generic
 *    "internal error" message.
 */

import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { Telegraf, type Context } from "telegraf";

import { consumePairingCode, getOrIssuePairingCode, isAuthorized } from "./auth.js";
import type { Config } from "./config.js";
import { parseAllowedChatIds } from "./config.js";
import {
  type AgentRow,
  type DB,
  createAgent,
  listAgents,
  recentMessages,
  updateAgentStatus,
} from "./db/index.js";
import { killAgent, runPrompt } from "./claude-runner.js";
import { snapshot } from "./quota.js";

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export interface BotDeps {
  db: DB;
  config: Config;
  logger: Logger;
}

/** Telegram message hard cap. See https://core.telegram.org/bots/api#sendmessage */
export const TELEGRAM_MAX = 4096;

/** Reserve a few chars for a "(1/N)" pagination footer. */
const PAGE_BUDGET = TELEGRAM_MAX - 16;

const GENERIC_ERROR = "internal error - check daemon log";
const NOT_PAIRED_HINT =
  "Unpaired. Look at the daemon's console for a 6-char code, then send `/pair <code>`.";

// ---------------------------------------------------------------------------
// Markdown escaping
// ---------------------------------------------------------------------------

/**
 * Escape a string for Telegram's legacy "Markdown" parse mode (only `*_` and
 * the backtick + bracket family must be escaped; we keep it conservative).
 * Per Telegram Bot API docs, the safer "MarkdownV2" demands escaping a long
 * list of glyphs; we use "Markdown" here to keep formatting predictable and
 * to avoid burning context on character classes the operator does not care
 * about. User input is escaped at the call site before interpolation.
 */
export function escapeMd(s: string): string {
  return s.replace(/([_*`\[])/g, "\\$1");
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * Split `text` into Telegram-safe chunks. Tries `\n\n` boundaries first,
 * falls back to `\n`, then to a hard slice at PAGE_BUDGET chars.
 */
export function paginate(text: string, budget: number = PAGE_BUDGET): string[] {
  if (text.length <= budget) return [text];

  const out: string[] = [];
  let remaining = text;
  while (remaining.length > budget) {
    const window = remaining.slice(0, budget);
    let cut = window.lastIndexOf("\n\n");
    if (cut < budget / 2) cut = window.lastIndexOf("\n");
    if (cut < budget / 2) cut = budget; // hard slice
    out.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}

async function sendPaginated(ctx: Context, text: string): Promise<void> {
  const pages = paginate(text);
  const total = pages.length;
  for (let i = 0; i < total; i++) {
    const page = pages[i];
    if (page === undefined) continue;
    const footer = total > 1 ? `\n\n_(${i + 1}/${total})_` : "";
    await ctx.reply(page + footer, { parse_mode: "Markdown" });
  }
}

// ---------------------------------------------------------------------------
// Auth gate
// ---------------------------------------------------------------------------

function authGate(deps: BotDeps): (ctx: Context) => boolean {
  const allowed = parseAllowedChatIds(deps.config.ALLOWED_CHAT_IDS);
  return (ctx: Context) => {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== "number") return false;
    return isAuthorized(deps.db, chatId, allowed);
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusEmoji(status: AgentRow["status"]): string {
  switch (status) {
    case "running":
      return "●";
    case "paused":
      return "⏸";
    case "crashed":
      return "💥";
    case "killed":
      return "—";
    case "idle":
    default:
      return "○";
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

function getAgentByName(db: DB, name: string): AgentRow | undefined {
  const all = listAgents(db);
  return all.find((a) => a.name === name);
}

function renderAgents(agents: AgentRow[]): string {
  if (agents.length === 0) {
    return "No agents yet. Create one with `/new <name> <cwd>`.";
  }
  const lines = agents.map((a) => {
    const cwd = truncate(a.cwd, 40);
    return `${statusEmoji(a.status)} \`${escapeMd(a.name)}\`  ${escapeMd(cwd)}`;
  });
  return ["*Agents*", ...lines].join("\n");
}

function renderQuota(snap: ReturnType<typeof snapshot>): string {
  const hours = Math.round(snap.windowMs / 3600000);
  const reset = snap.nextResetAt
    ? new Date(snap.nextResetAt).toISOString()
    : "(none)";
  const lastHit = snap.lastRateLimitAt
    ? new Date(snap.lastRateLimitAt).toISOString()
    : "(never)";
  return [
    "*Quota*",
    `window:           ${hours}h`,
    `requests:         ${snap.requestsInWindow}`,
    `tokens (est):     ${snap.tokensEstimated}`,
    `warning:          ${snap.warning ? "yes" : "no"}`,
    `last rate-limit:  ${lastHit}`,
    `next reset:       ${reset}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Command handlers — exported for direct unit testing
// ---------------------------------------------------------------------------

export interface HandlerCtx extends Context {
  // Telegraf populates these on command messages (CommandContextExtn):
  payload?: string;
  args?: string[];
}

export const handlers = {
  async start(deps: BotDeps, ctx: HandlerCtx): Promise<void> {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== "number") return;
    const allowed = parseAllowedChatIds(deps.config.ALLOWED_CHAT_IDS);
    if (!isAuthorized(deps.db, chatId, allowed)) {
      const code = getOrIssuePairingCode(deps.db);
      await ctx.reply(
        `Welcome. This daemon is locked.\n\nSend \`/pair <code>\` with the 6-char code printed on the daemon's console.\n\nExpected code length: ${code.length}.`,
        { parse_mode: "Markdown" },
      );
      return;
    }
    // Authorized → list agents
    await sendPaginated(ctx, renderAgents(listAgents(deps.db)));
  },

  async pair(deps: BotDeps, ctx: HandlerCtx): Promise<void> {
    const chatId = ctx.chat?.id;
    if (typeof chatId !== "number") return;
    const code = (ctx.payload ?? "").trim();
    if (!code) {
      await ctx.reply("Usage: `/pair <code>`", { parse_mode: "Markdown" });
      return;
    }
    const label =
      ctx.from?.username ?? (ctx.from?.first_name ?? null) ?? undefined;
    const ok = consumePairingCode(deps.db, code, chatId, label ?? undefined);
    if (!ok) {
      await ctx.reply("Pairing failed. Wrong or expired code.");
      return;
    }
    deps.logger.info({ chat_id: chatId, label }, "chat paired");
    await ctx.reply("Paired. Try `/agents`.", { parse_mode: "Markdown" });
  },

  async agents(deps: BotDeps, ctx: HandlerCtx): Promise<void> {
    await sendPaginated(ctx, renderAgents(listAgents(deps.db)));
  },

  async newAgent(deps: BotDeps, ctx: HandlerCtx): Promise<void> {
    const args = ctx.args ?? [];
    if (args.length < 2) {
      await ctx.reply("Usage: `/new <name> <cwd>`", { parse_mode: "Markdown" });
      return;
    }
    const name = args[0]!;
    const cwd = args.slice(1).join(" ");
    if (!existsSync(cwd)) {
      await ctx.reply(`cwd does not exist: \`${escapeMd(cwd)}\``, {
        parse_mode: "Markdown",
      });
      return;
    }
    if (getAgentByName(deps.db, name)) {
      await ctx.reply(`Agent \`${escapeMd(name)}\` already exists.`, {
        parse_mode: "Markdown",
      });
      return;
    }
    const id = randomUUID();
    const agent = createAgent(deps.db, { id, name, cwd });
    deps.logger.info({ id, name, cwd }, "agent created");
    await ctx.reply(
      `Created \`${escapeMd(agent.name)}\`\n  id:  \`${agent.id}\`\n  cwd: \`${escapeMd(agent.cwd)}\``,
      { parse_mode: "Markdown" },
    );
  },

  async run(deps: BotDeps, ctx: HandlerCtx): Promise<void> {
    const args = ctx.args ?? [];
    if (args.length < 2) {
      await ctx.reply("Usage: `/run <agent_name> <prompt>`", {
        parse_mode: "Markdown",
      });
      return;
    }
    const name = args[0]!;
    const prompt = args.slice(1).join(" ");
    const agent = getAgentByName(deps.db, name);
    if (!agent) {
      await ctx.reply(`Unknown agent: \`${escapeMd(name)}\``, {
        parse_mode: "Markdown",
      });
      return;
    }
    if (agent.status === "paused" && agent.paused_until && agent.paused_until > Date.now()) {
      const eta = new Date(agent.paused_until).toISOString();
      await ctx.reply(
        `\`${escapeMd(name)}\` is paused until ${eta}.`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    const placeholder = await ctx.reply(
      `\`${escapeMd(name)}\` working…`,
      { parse_mode: "Markdown" },
    );
    const chatId = placeholder.chat.id;
    const messageId = placeholder.message_id;

    updateAgentStatus(deps.db, agent.id, "running");

    let last = "";
    let lastEditAt = 0;
    const onChunk = (chunk: string): void => {
      last = (last + chunk).slice(-3500); // keep last 3.5k chars
      const now = Date.now();
      if (now - lastEditAt < 1500) return;
      lastEditAt = now;
      // Fire-and-forget; ignore edit failures (rate-limit, identical text).
      ctx.telegram
        .editMessageText(
          chatId,
          messageId,
          undefined,
          `\`${escapeMd(name)}\` working…\n\n${last}`,
          { parse_mode: "Markdown" },
        )
        .catch(() => {
          /* edit failed; will be overwritten on the next chunk */
        });
    };

    const result = await runPrompt(deps.db, {
      agentId: agent.id,
      cwd: agent.cwd,
      prompt,
      onChunk,
    });

    if (!result.ok) {
      // If the runner detected a rate-limit it has already called
      // pauseUntil(...) which set status='paused' + paused_until. Avoid
      // overwriting that with 'crashed' in the rate-limit case.
      if (!result.rateLimit) {
        updateAgentStatus(deps.db, agent.id, "crashed", null);
      }
      const reason = result.rateLimit
        ? `rate-limited until ${new Date(result.rateLimit.resetAt).toISOString()}`
        : (result.stderrSnippet || `exit ${result.exitCode ?? "?"}`);
      await sendPaginated(
        ctx,
        `\`${escapeMd(name)}\` failed:\n${escapeMd(reason)}`,
      );
      return;
    }

    updateAgentStatus(deps.db, agent.id, "idle");
    await sendPaginated(
      ctx,
      `\`${escapeMd(name)}\` finished:\n\n${result.text}`,
    );
  },

  async status(deps: BotDeps, ctx: HandlerCtx): Promise<void> {
    const agents = listAgents(deps.db);
    const counts = {
      idle: 0,
      running: 0,
      paused: 0,
      crashed: 0,
      killed: 0,
    } as Record<AgentRow["status"], number>;
    for (const a of agents) counts[a.status] = (counts[a.status] ?? 0) + 1;
    const snap = snapshot(deps.db);
    const text = [
      "*Status*",
      `agents:   total=${agents.length}  running=${counts.running}  idle=${counts.idle}  paused=${counts.paused}  crashed=${counts.crashed}  killed=${counts.killed}`,
      "",
      renderQuota(snap),
    ].join("\n");
    await sendPaginated(ctx, text);
  },

  async quota(deps: BotDeps, ctx: HandlerCtx): Promise<void> {
    await sendPaginated(ctx, renderQuota(snapshot(deps.db)));
  },

  async kill(deps: BotDeps, ctx: HandlerCtx): Promise<void> {
    const args = ctx.args ?? [];
    if (args.length < 1) {
      await ctx.reply("Usage: `/kill <agent_name>`", { parse_mode: "Markdown" });
      return;
    }
    const name = args[0]!;
    const agent = getAgentByName(deps.db, name);
    if (!agent) {
      await ctx.reply(`Unknown agent: \`${escapeMd(name)}\``, {
        parse_mode: "Markdown",
      });
      return;
    }
    const ok = await killAgent(agent.id);
    updateAgentStatus(deps.db, agent.id, "killed");
    deps.logger.info({ id: agent.id, name, ok }, "agent killed");
    await ctx.reply(
      ok
        ? `Killed \`${escapeMd(name)}\`.`
        : `\`${escapeMd(name)}\` had no live process; status set to killed.`,
      { parse_mode: "Markdown" },
    );
  },

  async help(_deps: BotDeps, ctx: HandlerCtx): Promise<void> {
    const lines = [
      "*Commands*",
      "`/start` — show pairing code or list agents",
      "`/pair <code>` — bind this chat",
      "`/agents` — list agents",
      "`/new <name> <cwd>` — register a new agent",
      "`/run <name> <prompt>` — dispatch a prompt",
      "`/status` — daemon snapshot",
      "`/quota` — quota window",
      "`/kill <name>` — terminate an agent",
      "`/help` — this message",
    ];
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  },

  // exposed for unit tests
  _internal: {
    renderAgents,
    renderQuota,
    paginate,
    escapeMd,
    getAgentByName,
    recentMessages,
  },
};

// ---------------------------------------------------------------------------
// buildBot
// ---------------------------------------------------------------------------

/**
 * Construct a configured Telegraf bot. Does NOT launch — caller invokes
 * `.launch()` after wiring SIGINT/SIGTERM.
 */
export function buildBot(deps: BotDeps): Telegraf {
  const bot = new Telegraf(deps.config.TELEGRAM_BOT_TOKEN);
  const gate = authGate(deps);

  // Global error trap — never crash the daemon over a handler exception.
  bot.catch((err, ctx) => {
    deps.logger.error(
      { err: String(err), update_type: ctx.updateType },
      "telegraf handler error",
    );
    // Best-effort user-facing notice.
    ctx
      .reply(GENERIC_ERROR)
      .catch((e) =>
        deps.logger.warn({ err: String(e) }, "failed to send error reply"),
      );
  });

  // Wrap each handler: gate first, then dispatch, then catch+log.
  type Handler = (deps: BotDeps, ctx: HandlerCtx) => Promise<void>;
  const wrap = (name: string, h: Handler) => async (ctx: HandlerCtx) => {
    if (name !== "start" && name !== "pair") {
      if (!gate(ctx)) {
        deps.logger.debug(
          { chat_id: ctx.chat?.id, command: name },
          "unauthorized chat dropped",
        );
        return; // silent drop
      }
    } else if (name === "start") {
      // /start is allowed for unauthorized chats so they can see the pairing hint.
    } else if (name === "pair") {
      // /pair is always allowed (it's how you become authorized).
    }
    try {
      await h(deps, ctx);
    } catch (err) {
      deps.logger.error(
        { err: String(err), command: name, chat_id: ctx.chat?.id },
        "handler crashed",
      );
      await ctx.reply(GENERIC_ERROR).catch(() => {
        /* swallow nested error */
      });
    }
  };

  bot.start(wrap("start", handlers.start));
  bot.help(wrap("help", handlers.help));
  bot.command("pair", wrap("pair", handlers.pair));
  bot.command("agents", wrap("agents", handlers.agents));
  bot.command("new", wrap("new", handlers.newAgent));
  bot.command("run", wrap("run", handlers.run));
  bot.command("status", wrap("status", handlers.status));
  bot.command("quota", wrap("quota", handlers.quota));
  bot.command("kill", wrap("kill", handlers.kill));

  // Silently drop everything else from unauthorized chats; reply with help
  // hint to authorized chats.
  bot.on("message", async (ctx) => {
    if (!gate(ctx)) return;
    await ctx.reply(NOT_PAIRED_HINT).catch(() => {
      /* swallow */
    });
  });

  return bot;
}
