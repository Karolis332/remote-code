/**
 * Unit tests for src/nlp.ts.
 *
 * `parseIntent` is pure and covers every command. `classify` is exercised via
 * a fake `NlpClient` injected into the bot — no real API calls.
 */

import { describe, expect, it } from "vitest";

import { parseIntent } from "./nlp.js";

describe("parseIntent", () => {
  it("parses a run intent", () => {
    const out = parseIntent(
      '{"command":"run","agent":"gi","prompt":"what is the status"}',
    );
    expect(out).toEqual({
      command: "run",
      agent: "gi",
      prompt: "what is the status",
    });
  });

  it("lowercases the agent name on run", () => {
    const out = parseIntent('{"command":"run","agent":"GI","prompt":"go"}');
    expect(out).toEqual({ command: "run", agent: "gi", prompt: "go" });
  });

  it("parses a kill intent", () => {
    expect(parseIntent('{"command":"kill","agent":"alpha"}')).toEqual({
      command: "kill",
      agent: "alpha",
    });
  });

  it("parses a new intent", () => {
    expect(
      parseIntent('{"command":"new","name":"beta","cwd":"C:/some/path"}'),
    ).toEqual({ command: "new", name: "beta", cwd: "C:/some/path" });
  });

  it("parses status / quota / agents / help", () => {
    expect(parseIntent('{"command":"status"}')).toEqual({ command: "status" });
    expect(parseIntent('{"command":"quota"}')).toEqual({ command: "quota" });
    expect(parseIntent('{"command":"agents"}')).toEqual({ command: "agents" });
    expect(parseIntent('{"command":"help"}')).toEqual({ command: "help" });
  });

  it("strips ```json fences", () => {
    const raw = '```json\n{"command":"status"}\n```';
    expect(parseIntent(raw)).toEqual({ command: "status" });
  });

  it("returns unknown on garbage", () => {
    expect(parseIntent("not json").command).toBe("unknown");
    expect(parseIntent("").command).toBe("unknown");
    expect(parseIntent("[]").command).toBe("unknown");
    expect(parseIntent('{"command":42}').command).toBe("unknown");
    expect(parseIntent('{"command":"nope"}').command).toBe("unknown");
  });

  it("returns unknown when required fields are missing", () => {
    expect(parseIntent('{"command":"run","agent":"a"}').command).toBe("unknown");
    expect(parseIntent('{"command":"run","prompt":"p"}').command).toBe("unknown");
    expect(parseIntent('{"command":"kill"}').command).toBe("unknown");
    expect(parseIntent('{"command":"new","name":"x"}').command).toBe("unknown");
  });

  it("passes through unknown intent with reason", () => {
    expect(parseIntent('{"command":"unknown","reason":"too vague"}')).toEqual({
      command: "unknown",
      reason: "too vague",
    });
  });
});
