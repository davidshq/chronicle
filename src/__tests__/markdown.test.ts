import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import {
  generateMarkdownPath,
  initMarkdownFile,
  getActiveMarkdownPath,
  appendUserMessage,
  appendToolCall,
  appendToolResult,
  appendAssistantMessage,
  finalizeMarkdownFile,
} from "../markdown";

const TEST_LOG_DIR = join(import.meta.dir, ".test-logs");

beforeEach(() => {
  mkdirSync(TEST_LOG_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_LOG_DIR, { recursive: true, force: true });
});

describe("generateMarkdownPath", () => {
  test("generates path with correct format", () => {
    const date = new Date("2026-01-16T14:30:45Z");
    const path = generateMarkdownPath("abc12345-session", "/my/project", date, TEST_LOG_DIR);

    expect(path).toContain("sessions");
    expect(path).toContain("2026-01-16");
    expect(path).toContain("abc12345");
    expect(path).toContain("project");
    expect(path).toEndWith(".md");
  });

  test("sanitizes project name", () => {
    const date = new Date("2026-01-16T14:30:45Z");
    const path = generateMarkdownPath("session-1", "/path/to/My Project!@#", date, TEST_LOG_DIR);

    expect(path).toContain("My-Project");
    expect(path).not.toContain("!");
    expect(path).not.toContain("@");
  });

  test("increments sequence number for same day", () => {
    const date = new Date("2026-01-16T10:00:00Z");

    const path1 = generateMarkdownPath("session-1", "/project", date, TEST_LOG_DIR);
    initMarkdownFile("session-1", "/project", date.toISOString(), "startup", TEST_LOG_DIR);

    const path2 = generateMarkdownPath("session-2", "/project", date, TEST_LOG_DIR);

    expect(path1).toContain("01_");
    expect(path2).toContain("02_");
  });
});

describe("initMarkdownFile", () => {
  test("creates markdown file with header", () => {
    const filePath = initMarkdownFile(
      "test-session-123",
      "/test/project",
      "2026-01-16T10:00:00Z",
      "startup",
      TEST_LOG_DIR
    );

    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("# Session: test-session-123");
    expect(content).toContain("**Project**: `/test/project`");
    expect(content).toContain("**Started**: 2026-01-16T10:00:00Z");
    expect(content).toContain("**Status**: Active");
  });

  test("registers session in active sessions", () => {
    initMarkdownFile(
      "active-session-test",
      "/test/project",
      "2026-01-16T10:00:00Z",
      "startup",
      TEST_LOG_DIR
    );

    const activePath = getActiveMarkdownPath("active-session-test");
    expect(activePath).not.toBeNull();
  });

  test("resumes existing session with marker", () => {
    // Create initial session
    const filePath = initMarkdownFile(
      "resume-session",
      "/test/project",
      "2026-01-16T10:00:00Z",
      "startup",
      TEST_LOG_DIR
    );

    // Resume same session
    const resumedPath = initMarkdownFile(
      "resume-session",
      "/test/project",
      "2026-01-16T11:00:00Z",
      "resume",
      TEST_LOG_DIR
    );

    expect(resumedPath).toBe(filePath);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("## Session Resumed");
  });
});

describe("appendUserMessage", () => {
  test("appends user message to file", () => {
    const filePath = initMarkdownFile(
      "user-msg-session",
      "/test",
      "2026-01-16T10:00:00Z",
      "startup",
      TEST_LOG_DIR
    );

    appendUserMessage("user-msg-session", "2026-01-16T10:01:00Z", "Hello, Claude!");

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("## User");
    expect(content).toContain("Hello, Claude!");
  });

  test("does nothing for unknown session", () => {
    // Should not throw
    appendUserMessage("unknown-session", "2026-01-16T10:00:00Z", "Test");
  });
});

describe("appendToolCall", () => {
  test("formats Bash tool call", () => {
    const filePath = initMarkdownFile(
      "bash-tool-session",
      "/test",
      "2026-01-16T10:00:00Z",
      "startup",
      TEST_LOG_DIR
    );

    appendToolCall("bash-tool-session", "2026-01-16T10:01:00Z", "Bash", {
      command: "ls -la",
      description: "List files",
    });

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("### Tool: Bash");
    expect(content).toContain("**Command**: `ls -la`");
    expect(content).toContain("**Description**: List files");
  });

  test("formats Read tool call", () => {
    const filePath = initMarkdownFile(
      "read-tool-session",
      "/test",
      "2026-01-16T10:00:00Z",
      "startup",
      TEST_LOG_DIR
    );

    appendToolCall("read-tool-session", "2026-01-16T10:01:00Z", "Read", {
      file_path: "/path/to/file.ts",
    });

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("### Tool: Read");
    expect(content).toContain("**File**: `/path/to/file.ts`");
  });

  test("formats Edit tool call", () => {
    const filePath = initMarkdownFile(
      "edit-tool-session",
      "/test",
      "2026-01-16T10:00:00Z",
      "startup",
      TEST_LOG_DIR
    );

    appendToolCall("edit-tool-session", "2026-01-16T10:01:00Z", "Edit", {
      file_path: "/path/to/file.ts",
      old_string: "const x = 1",
      new_string: "const x = 2",
    });

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("### Tool: Edit");
    expect(content).toContain("**Replace**:");
    expect(content).toContain("const x = 1");
    expect(content).toContain("**With**:");
    expect(content).toContain("const x = 2");
  });

  test("formats unknown tool with JSON", () => {
    const filePath = initMarkdownFile(
      "unknown-tool-session",
      "/test",
      "2026-01-16T10:00:00Z",
      "startup",
      TEST_LOG_DIR
    );

    appendToolCall("unknown-tool-session", "2026-01-16T10:01:00Z", "CustomTool", {
      foo: "bar",
      baz: 123,
    });

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("### Tool: CustomTool");
    expect(content).toContain('"foo": "bar"');
  });
});

describe("appendToolResult", () => {
  test("appends success result", () => {
    const filePath = initMarkdownFile(
      "result-session",
      "/test",
      "2026-01-16T10:00:00Z",
      "startup",
      TEST_LOG_DIR
    );

    appendToolResult("result-session", "Bash", true, "command output");

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("**Result**: ✓ Success");
  });

  test("appends failure result", () => {
    const filePath = initMarkdownFile(
      "fail-session",
      "/test",
      "2026-01-16T10:00:00Z",
      "startup",
      TEST_LOG_DIR
    );

    appendToolResult("fail-session", "Bash", false);

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("**Result**: ✗ Failed");
  });
});

describe("appendAssistantMessage", () => {
  test("appends assistant message", () => {
    const filePath = initMarkdownFile(
      "assistant-session",
      "/test",
      "2026-01-16T10:00:00Z",
      "startup",
      TEST_LOG_DIR
    );

    appendAssistantMessage(
      "assistant-session",
      "2026-01-16T10:01:00Z",
      "I'll help you with that!"
    );

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("## Assistant");
    expect(content).toContain("I'll help you with that!");
  });
});

describe("finalizeMarkdownFile", () => {
  test("updates status and adds end marker", () => {
    const filePath = initMarkdownFile(
      "finalize-session",
      "/test/project",
      "2026-01-16T10:00:00Z",
      "startup",
      TEST_LOG_DIR
    );

    finalizeMarkdownFile("finalize-session", "Completed", "/test/project");

    const content = readFileSync(filePath, "utf-8");
    expect(content).toContain("**Status**: Completed");
    expect(content).toContain("## Session Ended");
  });

  test("removes session from active sessions", () => {
    initMarkdownFile(
      "remove-session",
      "/test",
      "2026-01-16T10:00:00Z",
      "startup",
      TEST_LOG_DIR
    );

    expect(getActiveMarkdownPath("remove-session")).not.toBeNull();

    finalizeMarkdownFile("remove-session", "Completed", "/test");

    expect(getActiveMarkdownPath("remove-session")).toBeNull();
  });
});
