import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { parseTranscript, getLatestAssistantResponse } from "../transcript";

const TEST_DIR = join(import.meta.dir, ".test-fixtures");
const TEST_FILE = join(TEST_DIR, "transcript.jsonl");

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("parseTranscript", () => {
  test("returns empty array for non-existent file", () => {
    const result = parseTranscript("/non/existent/path.jsonl");
    expect(result).toEqual([]);
  });

  test("parses human/assistant type format", () => {
    const lines = [
      JSON.stringify({
        uuid: "msg-1",
        type: "human",
        message: { role: "user", content: "Hello" },
        timestamp: "2026-01-16T10:00:00Z",
      }),
      JSON.stringify({
        uuid: "msg-2",
        type: "assistant",
        message: { role: "assistant", content: "Hi there!" },
        timestamp: "2026-01-16T10:00:01Z",
      }),
    ];
    writeFileSync(TEST_FILE, lines.join("\n"));

    const result = parseTranscript(TEST_FILE);

    expect(result).toHaveLength(2);
    expect(result[0].role).toBe("user");
    expect(result[0].textContent).toBe("Hello");
    expect(result[1].role).toBe("assistant");
    expect(result[1].textContent).toBe("Hi there!");
  });

  test("parses message format with content blocks", () => {
    const lines = [
      JSON.stringify({
        uuid: "msg-1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Let me help with that." },
            { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/test.txt" } },
          ],
        },
      }),
    ];
    writeFileSync(TEST_FILE, lines.join("\n"));

    const result = parseTranscript(TEST_FILE);

    expect(result).toHaveLength(1);
    expect(result[0].textContent).toBe("Let me help with that.");
    expect(result[0].toolCalls).toHaveLength(1);
    expect(result[0].toolCalls[0].name).toBe("Read");
    expect(result[0].toolCalls[0].input).toEqual({ file_path: "/tmp/test.txt" });
  });

  test("parses tool_result blocks", () => {
    const lines = [
      JSON.stringify({
        uuid: "msg-1",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: "file contents here" },
          ],
        },
      }),
    ];
    writeFileSync(TEST_FILE, lines.join("\n"));

    const result = parseTranscript(TEST_FILE);

    expect(result).toHaveLength(1);
    expect(result[0].toolResults).toHaveLength(1);
    expect(result[0].toolResults[0].toolUseId).toBe("tool-1");
    expect(result[0].toolResults[0].content).toBe("file contents here");
  });

  test("skips malformed JSON lines gracefully", () => {
    const lines = [
      JSON.stringify({ uuid: "msg-1", type: "human", message: { content: "Valid" } }),
      "{ invalid json",
      JSON.stringify({ uuid: "msg-2", type: "assistant", message: { content: "Also valid" } }),
    ];
    writeFileSync(TEST_FILE, lines.join("\n"));

    const result = parseTranscript(TEST_FILE);

    expect(result).toHaveLength(2);
    expect(result[0].textContent).toBe("Valid");
    expect(result[1].textContent).toBe("Also valid");
  });

  test("skips empty lines", () => {
    const lines = [
      JSON.stringify({ uuid: "msg-1", type: "human", message: { content: "Hello" } }),
      "",
      "   ",
      JSON.stringify({ uuid: "msg-2", type: "assistant", message: { content: "Hi" } }),
    ];
    writeFileSync(TEST_FILE, lines.join("\n"));

    const result = parseTranscript(TEST_FILE);

    expect(result).toHaveLength(2);
  });

  test("handles entries without message content", () => {
    const lines = [
      JSON.stringify({ uuid: "msg-1", type: "human", message: {} }),
      JSON.stringify({ uuid: "msg-2", type: "assistant", message: { content: "Valid" } }),
    ];
    writeFileSync(TEST_FILE, lines.join("\n"));

    const result = parseTranscript(TEST_FILE);

    expect(result).toHaveLength(1);
    expect(result[0].textContent).toBe("Valid");
  });

  test("joins multiple text blocks with newlines", () => {
    const lines = [
      JSON.stringify({
        uuid: "msg-1",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "First paragraph." },
            { type: "text", text: "Second paragraph." },
          ],
        },
      }),
    ];
    writeFileSync(TEST_FILE, lines.join("\n"));

    const result = parseTranscript(TEST_FILE);

    expect(result[0].textContent).toBe("First paragraph.\nSecond paragraph.");
  });
});

describe("getLatestAssistantResponse", () => {
  test("returns null for non-existent file", () => {
    const result = getLatestAssistantResponse("/non/existent/path.jsonl");
    expect(result).toBeNull();
  });

  test("returns null when no assistant messages exist", () => {
    const lines = [
      JSON.stringify({ uuid: "msg-1", type: "human", message: { content: "Hello" } }),
    ];
    writeFileSync(TEST_FILE, lines.join("\n"));

    const result = getLatestAssistantResponse(TEST_FILE);

    expect(result).toBeNull();
  });

  test("returns the last assistant message", () => {
    const lines = [
      JSON.stringify({ uuid: "msg-1", type: "human", message: { content: "Q1" } }),
      JSON.stringify({ uuid: "msg-2", type: "assistant", message: { content: "A1" } }),
      JSON.stringify({ uuid: "msg-3", type: "human", message: { content: "Q2" } }),
      JSON.stringify({ uuid: "msg-4", type: "assistant", message: { content: "A2" } }),
    ];
    writeFileSync(TEST_FILE, lines.join("\n"));

    const result = getLatestAssistantResponse(TEST_FILE);

    expect(result).toBe("A2");
  });

  test("skips assistant messages with empty content", () => {
    const lines = [
      JSON.stringify({ uuid: "msg-1", type: "assistant", message: { content: "Real answer" } }),
      JSON.stringify({ uuid: "msg-2", type: "assistant", message: { content: "   " } }),
    ];
    writeFileSync(TEST_FILE, lines.join("\n"));

    const result = getLatestAssistantResponse(TEST_FILE);

    expect(result).toBe("Real answer");
  });
});
