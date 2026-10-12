/**
 * Natural-language command router.
 *
 * Given a free-text user message and the list of known agent names, ask
 * Claude Haiku to map it to one of the existing bot commands and return a
 * JSON object: {command, args}. If the model is unsure, it returns
 * `{command: "unknown"}` and the caller falls back to the soft hint.
 *
 * The Anthropic client is injected so tests can stub the API.
 *
 * Anthropic SDK docs: https://docs.anthropic.com/en/api/messages
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { Logger } from "pino";

export const DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

export type Intent =
  | { command: "run"; agent: string; prompt: string }
  | { command: "kill"; agent: string }
  | { command: "new"; name: string; cwd: string }
  | { command: "status" }
  | { command: "quota" }
  | { command: "agents" }
  | { command: "help" }
  | { command: "unknown"; reason?: string };

export interface NlpClient {
  classify(text: string, agentNames: string[]): Promise<Intent>;
}

export interface NlpClientDeps {
  apiKey: string;
  model: string;
  logger: Logger;
}

const SYSTEM_PROMPT = `You are a strict intent parser for a Telegram bot that controls Claude Code agents.

Map the user's free-text message to ONE of these JSON intents:

- {"command":"run","agent":"<name>","prompt":"<verbatim task>"} — user wants an agent to do something
- {"command":"kill","agent":"<name>"} — stop/terminate an agent
- {"command":"new","name":"<name>","cwd":"<absolute path>"} — create/spawn a new agent
- {"command":"status"} — overall daemon status
- {"command":"quota"} — quota / rate-limit usage
- {"command":"agents"} — list agents
- {"command":"help"} — list commands
- {"command":"unknown","reason":"<short>"} — message is ambiguous, off-topic, or no matching command

RULES:
1. Output ONLY a single JSON object. No prose, no markdown, no code fences.
2. For "run" and "kill", the named agent MUST already exist in the known-agents list (case-insensitive; lower-case the output). If it does not, return "unknown".
3. For "new", the agent name is being created right now — it MUST NOT be in the known list. Extract the new name verbatim and the cwd path verbatim.
4. For "run", the "prompt" field is the task verbatim, with the agent name and routing verb stripped.
5. Treat usage / token / rate-limit / "how much have I used" questions as "quota".
6. Treat "what's running", "what's going on", "status report" as "status".
7. Be conservative: if intent is unclear, return "unknown" rather than guessing.

EXAMPLES:
- "tell gi to fix the build"               → {"command":"run","agent":"gi","prompt":"fix the build"}
- "kill alpha"                              → {"command":"kill","agent":"alpha"}
- "spawn a new agent called beta at C:/x"  → {"command":"new","name":"beta","cwd":"C:/x"}
- "what's running right now"                → {"command":"status"}
- "how many tokens have I burned today"     → {"command":"quota"}
- "list the agents"                         → {"command":"agents"}
- "make me a sandwich"                      → {"command":"unknown","reason":"off-topic"}`;

export function makeOpenAIClient(deps: NlpClientDeps): NlpClient {
  const client = new OpenAI({ apiKey: deps.apiKey });
  return {
    async classify(text: string, agentNames: string[]): Promise<Intent> {
      const known = agentNames.length > 0 ? agentNames.join(", ") : "(none)";
      const userMsg = `Known agents: ${known}\n\nUser message: ${text}`;
      try {
        const resp = await client.chat.completions.create({
          model: deps.model,
          max_tokens: 200,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMsg },
          ],
        });
        const content = resp.choices[0]?.message?.content;
        if (!content) return { command: "unknown", reason: "no content" };
        return parseIntent(content);
      } catch (err) {
        deps.logger.warn({ err: String(err) }, "openai.classify failed");
        return { command: "unknown", reason: "api error" };
      }
    },
  };
}

export function makeAnthropicClient(deps: NlpClientDeps): NlpClient {
  const client = new Anthropic({ apiKey: deps.apiKey });
  return {
    async classify(text: string, agentNames: string[]): Promise<Intent> {
      const known = agentNames.length > 0 ? agentNames.join(", ") : "(none)";
      const userMsg = `Known agents: ${known}\n\nUser message: ${text}`;
      try {
        const resp = await client.messages.create({
          model: deps.model,
          max_tokens: 200,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMsg }],
        });
        const block = resp.content[0];
        if (!block || block.type !== "text") {
          return { command: "unknown", reason: "no text block" };
        }
        return parseIntent(block.text);
      } catch (err) {
        deps.logger.warn({ err: String(err) }, "nlp.classify failed");
        return { command: "unknown", reason: "api error" };
      }
    },
  };
}

/**
 * Parse the model's JSON output into a validated Intent. Returns
 * `{command: "unknown"}` on any parse failure — the caller treats it as a
 * miss and shows the soft hint.
 */
export function parseIntent(raw: string): Intent {
  const trimmed = raw.trim();
  // The model sometimes wraps JSON in ```json fences despite instructions.
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return { command: "unknown", reason: "non-json output" };
  }
  if (!parsed || typeof parsed !== "object") {
    return { command: "unknown", reason: "not an object" };
  }
  const obj = parsed as Record<string, unknown>;
  const cmd = obj.command;
  if (typeof cmd !== "string") {
    return { command: "unknown", reason: "missing command field" };
  }
  switch (cmd) {
    case "run": {
      const agent = strField(obj.agent);
      const prompt = strField(obj.prompt);
      if (!agent || !prompt) return unknown("run requires agent + prompt");
      return { command: "run", agent: agent.toLowerCase(), prompt };
    }
    case "kill": {
      const agent = strField(obj.agent);
      if (!agent) return unknown("kill requires agent");
      return { command: "kill", agent: agent.toLowerCase() };
    }
    case "new": {
      const name = strField(obj.name);
      const cwd = strField(obj.cwd);
      if (!name || !cwd) return unknown("new requires name + cwd");
      return { command: "new", name, cwd };
    }
    case "status":
      return { command: "status" };
    case "quota":
      return { command: "quota" };
    case "agents":
      return { command: "agents" };
    case "help":
      return { command: "help" };
    case "unknown":
      return { command: "unknown", reason: strField(obj.reason) ?? undefined };
    default:
      return unknown(`unknown command "${cmd}"`);
  }
}

function strField(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

function unknown(reason: string): Intent {
  return { command: "unknown", reason };
}
