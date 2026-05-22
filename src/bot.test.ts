/**
 * Unit tests for src/bot.ts.
 *
 * We do NOT launch a real Telegraf instance. We exercise the pure helpers
 * (paginate / escapeMd) and call exported command handlers directly with a
 * minimal fake context. This keeps tests offline and deterministic.
 */

import { describe, expect, it, vi } from "vitest";
import pino from "pino";

import {
  TELEGRAM_MAX,
  buildBot,
  escapeMd,
  handlers,
  paginate,
} from "./bot.js";
import { getOrIssuePairingCode } from "./auth.js";
import type { Config } from "./config.js";
import { type DB, migrate, openDB } from "./db/index.js";

function silentLogger() {
  return pino({ level: "silent" });
}

function freshDb(): DB {
  const db = openDB(":memory:");
  migrate(db);
  return db;
}

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    TELEGRAM_BOT_TOKEN: "0123456789:abcdefghijklmnopqrstuvwxyz0123456789",
    ALLOWED_CHAT_IDS: "",
    CLAUDE_BIN: "claude",
    LOG_LEVEL: "info",
    ...overrides,
  } as Config;
}

interface CapturedReply {
  text: string;
  extra?: Record<string, unknown>;
}

interface FakeCtx {
  replies: CapturedReply[];
  edits: Array<{ chatId: number; messageId: number; text: string }>;
  chat: { id: number; type: "private" };
  from: { id: number; username?: string };
  payload: string;
  args: string[];
  message: { text: string };
  telegram: {
    editMessageText: ReturnType<typeof vi.fn>;
  };
  reply: (text: string, extra?: Record<string, unknown>) => Promise<{
    chat: { id: number };
    message_id: number;
  }>;
}

function makeCtx(opts: {
  chatId: number;
  payload?: string;
  args?: string[];
  text?: string;
}): FakeCtx {
  const replies: CapturedReply[] = [];
  const edits: FakeCtx["edits"] = [];
  let messageIdSeq = 1;
  return {
    replies,
    edits,
    chat: { id: opts.chatId, type: "private" },
    from: { id: opts.chatId, username: "operator" },
    payload: opts.payload ?? "",
    args: opts.args ?? [],
    message: { text: opts.text ?? "" },
    telegram: {
      editMessageText: vi
        .fn()
        .mockImplementation(
          (chatId: number, messageId: number, _inline: unknown, text: string) => {
            edits.push({ chatId, messageId, text });
            return Promise.resolve(true);
          },
        ),
    },
    reply(text, extra) {
      replies.push({ text, extra });
      return Promise.resolve({
        chat: { id: opts.chatId },
        message_id: messageIdSeq++,
      });
    },
  };
}

describe("escapeMd", () => {
  it("escapes Markdown specials", () => {
    expect(escapeMd("hello _world_ *bold*")).toBe(
      "hello \\_world\\_ \\*bold\\*",
    );
    expect(escapeMd("path/to/file.ts")).toBe("path/to/file.ts");
    expect(escapeMd("`code` [link]")).toBe("\\`code\\` \\[link]");
  });
});

describe("paginate", () => {
  it("returns input unchanged when under budget", () => {
    expect(paginate("short")).toEqual(["short"]);
  });

  it("splits on paragraph boundary when possible", () => {
    const a = "para1\n".repeat(500);
    const b = "para2\n".repeat(500);
    const text = `${a}\n\n${b}`;
    const pages = paginate(text);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    for (const p of pages) expect(p.length).toBeLessThanOrEqual(TELEGRAM_MAX);
  });

  it("hard-slices ultra-long unbroken text", () => {
    const text = "x".repeat(15000);
    const pages = paginate(text);
    expect(pages.length).toBeGreaterThan(1);
    for (const p of pages) expect(p.length).toBeLessThanOrEqual(TELEGRAM_MAX);
    expect(pages.join("")).toBe(text);
  });
});

describe("buildBot", () => {
  it("constructs a Telegraf instance without throwing", () => {
    const db = freshDb();
    const bot = buildBot({ db, config: fakeConfig(), logger: silentLogger() });
    expect(bot).toBeDefined();
    // The instance should expose .launch and .stop (telegraf v4 API).
    expect(typeof bot.launch).toBe("function");
    expect(typeof bot.stop).toBe("function");
  });
});

describe("handlers.start", () => {
  it("shows pairing instructions to an unpaired chat", async () => {
    const db = freshDb();
    const deps = { db, config: fakeConfig(), logger: silentLogger() };
    const ctx = makeCtx({ chatId: 1 });
    await handlers.start(deps, ctx as never);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]!.text).toMatch(/locked/i);
  });

  it("lists agents for an authorized chat", async () => {
    const db = freshDb();
    const deps = {
      db,
      config: fakeConfig({ ALLOWED_CHAT_IDS: "42" }),
      logger: silentLogger(),
    };
    const ctx = makeCtx({ chatId: 42 });
    await handlers.start(deps, ctx as never);
    expect(ctx.replies).toHaveLength(1);
    expect(ctx.replies[0]!.text).toMatch(/no agents yet|Agents/i);
  });
});

describe("handlers.pair", () => {
  it("rejects empty payload", async () => {
    const db = freshDb();
    const deps = { db, config: fakeConfig(), logger: silentLogger() };
    const ctx = makeCtx({ chatId: 1, payload: "" });
    await handlers.pair(deps, ctx as never);
    expect(ctx.replies[0]!.text).toMatch(/usage/i);
  });

  it("confirms successful pairing", async () => {
    const db = freshDb();
    const deps = { db, config: fakeConfig(), logger: silentLogger() };
    const code = getOrIssuePairingCode(db);
    const ctx = makeCtx({ chatId: 7, payload: code });
    await handlers.pair(deps, ctx as never);
    expect(ctx.replies[0]!.text).toMatch(/paired/i);
  });

  it("reports failure on wrong code", async () => {
    const db = freshDb();
    const deps = { db, config: fakeConfig(), logger: silentLogger() };
    getOrIssuePairingCode(db);
    const ctx = makeCtx({ chatId: 7, payload: "WRONG1" });
    await handlers.pair(deps, ctx as never);
    expect(ctx.replies[0]!.text).toMatch(/failed/i);
  });
});

describe("handlers.newAgent + agents + kill", () => {
  it("rejects missing args, missing cwd, then creates + lists + kills", async () => {
    const db = freshDb();
    const deps = {
      db,
      config: fakeConfig({ ALLOWED_CHAT_IDS: "1" }),
      logger: silentLogger(),
    };

    // 1. Missing args
    let ctx = makeCtx({ chatId: 1, args: [] });
    await handlers.newAgent(deps, ctx as never);
    expect(ctx.replies[0]!.text).toMatch(/usage/i);

    // 2. Non-existent cwd
    ctx = makeCtx({ chatId: 1, args: ["alpha", "C:\\definitely-not-a-real-dir-xyz"] });
    await handlers.newAgent(deps, ctx as never);
    expect(ctx.replies[0]!.text).toMatch(/does not exist/i);

    // 3. Real cwd (process.cwd())
    const cwd = process.cwd();
    ctx = makeCtx({ chatId: 1, args: ["alpha", cwd] });
    await handlers.newAgent(deps, ctx as never);
    expect(ctx.replies[0]!.text).toMatch(/created/i);

    // 4. Listing shows the agent
    ctx = makeCtx({ chatId: 1 });
    await handlers.agents(deps, ctx as never);
    expect(ctx.replies[0]!.text).toMatch(/alpha/);

    // 5. Kill an unknown agent
    ctx = makeCtx({ chatId: 1, args: ["ghost"] });
    await handlers.kill(deps, ctx as never);
    expect(ctx.replies[0]!.text).toMatch(/unknown/i);

    // 6. Kill the real one
    ctx = makeCtx({ chatId: 1, args: ["alpha"] });
    await handlers.kill(deps, ctx as never);
    expect(ctx.replies[0]!.text).toMatch(/killed|status set to killed/i);
  });
});

describe("handlers.status + quota", () => {
  it("renders status + quota without throwing", async () => {
    const db = freshDb();
    const deps = {
      db,
      config: fakeConfig({ ALLOWED_CHAT_IDS: "9" }),
      logger: silentLogger(),
    };
    const a = makeCtx({ chatId: 9 });
    await handlers.status(deps, a as never);
    expect(a.replies[0]!.text).toMatch(/Status/);

    const b = makeCtx({ chatId: 9 });
    await handlers.quota(deps, b as never);
    expect(b.replies[0]!.text).toMatch(/Quota/);
  });
});

describe("handlers.help", () => {
  it("returns a Markdown command list", async () => {
    const db = freshDb();
    const deps = {
      db,
      config: fakeConfig({ ALLOWED_CHAT_IDS: "1" }),
      logger: silentLogger(),
    };
    const ctx = makeCtx({ chatId: 1 });
    await handlers.help(deps, ctx as never);
    expect(ctx.replies[0]!.text).toMatch(/\/run/);
    expect(ctx.replies[0]!.text).toMatch(/\/agents/);
  });
});
