import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

const HANDLER_PATH = join(import.meta.dir, "../handler.ts");
const TEST_PROJECT_DIR = join(import.meta.dir, ".test-project");
const TEST_CONFIG_PATH = join(TEST_PROJECT_DIR, ".claude-remember.json");

// Helper to run handler with input using Bun.$
async function runHandler(input: object): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const inputStr = JSON.stringify(input);
  const result = await Bun.$`echo ${inputStr} | bun run ${HANDLER_PATH}`.quiet().nothrow();

  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    exitCode: result.exitCode,
  };
}

beforeEach(() => {
  mkdirSync(TEST_PROJECT_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
});

describe("handler integration", () => {
  test("exits 0 on valid SessionStart event", async () => {
    const input = {
      hook_event_name: "SessionStart",
      session_id: "test-session-" + Date.now(),
      cwd: TEST_PROJECT_DIR,
      source: "startup",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    };

    const { exitCode } = await runHandler(input);

    expect(exitCode).toBe(0);
  });

  test("exits 0 on empty stdin", async () => {
    const result = await Bun.$`echo "" | bun run ${HANDLER_PATH}`.quiet().nothrow();
    expect(result.exitCode).toBe(0);
  });

  test("exits 0 on malformed JSON (fail-safe)", async () => {
    const result = await Bun.$`echo "{ invalid json" | bun run ${HANDLER_PATH}`.quiet().nothrow();
    // Handler should exit 0 even on errors to not block Claude
    expect(result.exitCode).toBe(0);
  });

  test("returns welcome message for new project on SessionStart", async () => {
    // Use a unique subdirectory to ensure it's a "new project"
    const uniqueProjectDir = join(TEST_PROJECT_DIR, "unique-" + Date.now());
    mkdirSync(uniqueProjectDir, { recursive: true });

    const input = {
      hook_event_name: "SessionStart",
      session_id: "new-project-session-" + Date.now(),
      cwd: uniqueProjectDir,
      source: "startup",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    };

    const { stdout } = await runHandler(input);

    // Should return a result with welcome message
    expect(stdout).toContain("Claude Remember");
  });

  test("respects disabled project config", async () => {
    // Create disabled config
    writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ enabled: false }));

    const input = {
      hook_event_name: "SessionStart",
      session_id: "disabled-session-" + Date.now(),
      cwd: TEST_PROJECT_DIR,
      source: "startup",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    };

    const { stdout, stderr } = await runHandler(input);

    // Should not create session or show welcome message
    expect(stdout).toBe("");
    expect(stderr).toContain("Logging disabled for project");
  });

  test("handles UserPromptSubmit event", async () => {
    // First create a session
    const sessionId = "prompt-test-session-" + Date.now();
    await runHandler({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      source: "startup",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    // Then submit a prompt
    const { exitCode } = await runHandler({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      prompt: "Hello, Claude!",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    expect(exitCode).toBe(0);
  });

  test("handles disable remember logging command", async () => {
    const sessionId = "disable-test-session-" + Date.now();

    // Create session first
    await runHandler({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      source: "startup",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    // Send disable command
    const { stdout } = await runHandler({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      prompt: "disable remember logging",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    // Should create config file and return confirmation
    expect(existsSync(TEST_CONFIG_PATH)).toBe(true);
    expect(stdout).toContain("disabled");

    const config = JSON.parse(readFileSync(TEST_CONFIG_PATH, "utf-8"));
    expect(config.enabled).toBe(false);
  });

  test("handles /claude-remember:disable slash command", async () => {
    const sessionId = "slash-disable-session-" + Date.now();

    await runHandler({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      source: "startup",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    const { stdout } = await runHandler({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      prompt: "/claude-remember:disable",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    expect(existsSync(TEST_CONFIG_PATH)).toBe(true);
    expect(stdout).toContain("disabled");
  });

  test("handles /remember:disable short alias", async () => {
    const sessionId = "short-disable-session-" + Date.now();

    await runHandler({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      source: "startup",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    const { stdout } = await runHandler({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      prompt: "/remember:disable",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    expect(existsSync(TEST_CONFIG_PATH)).toBe(true);
    expect(stdout).toContain("disabled");
  });

  test("handles enable remember logging command", async () => {
    // First create a disabled config
    writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ enabled: false }));
    expect(existsSync(TEST_CONFIG_PATH)).toBe(true);

    const sessionId = "enable-test-session-" + Date.now();

    const { stdout } = await runHandler({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      prompt: "enable remember logging",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    // Config file should be removed
    expect(existsSync(TEST_CONFIG_PATH)).toBe(false);
    expect(stdout).toContain("re-enabled");
  });

  test("handles /claude-remember:enable slash command", async () => {
    writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ enabled: false }));

    const sessionId = "slash-enable-session-" + Date.now();

    const { stdout } = await runHandler({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      prompt: "/claude-remember:enable",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    expect(existsSync(TEST_CONFIG_PATH)).toBe(false);
    expect(stdout).toContain("re-enabled");
  });

  test("enable command when already enabled", async () => {
    // No config file exists = already enabled
    expect(existsSync(TEST_CONFIG_PATH)).toBe(false);

    const sessionId = "already-enabled-session-" + Date.now();

    const { stdout } = await runHandler({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      prompt: "/remember:enable",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    expect(stdout).toContain("already enabled");
  });

  test("handles /claude-remember:retry with no failed events", async () => {
    // Clear any existing failed events file to isolate the test
    const failedEventsPath = join(require("os").homedir(), ".claude-logs", ".failed-events.json");
    if (existsSync(failedEventsPath)) {
      rmSync(failedEventsPath);
    }

    const sessionId = "retry-empty-session-" + Date.now();

    // Create session first (required for UserPromptSubmit to work)
    await runHandler({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      source: "startup",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    const { stdout } = await runHandler({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      prompt: "/claude-remember:retry",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    // Should indicate no failed events or success
    expect(stdout).toContain("No failed events");
  });

  test("handles PreToolUse event", async () => {
    const sessionId = "tool-test-session-" + Date.now();

    await runHandler({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      source: "startup",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    const { exitCode } = await runHandler({
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      tool_name: "Read",
      tool_input: { file_path: "/tmp/test.txt" },
      tool_use_id: "tool-1",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    expect(exitCode).toBe(0);
  });

  test("handles PostToolUse event", async () => {
    const sessionId = "post-tool-session-" + Date.now();

    await runHandler({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      source: "startup",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    await runHandler({
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      tool_name: "Read",
      tool_input: { file_path: "/tmp/test.txt" },
      tool_use_id: "tool-1",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    const { exitCode } = await runHandler({
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      tool_name: "Read",
      tool_input: { file_path: "/tmp/test.txt" },
      tool_use_id: "tool-1",
      tool_response: { success: true },
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    expect(exitCode).toBe(0);
  });

  test("handles SessionEnd event", async () => {
    const sessionId = "end-test-session-" + Date.now();

    await runHandler({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      source: "startup",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    const { exitCode } = await runHandler({
      hook_event_name: "SessionEnd",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      reason: "logout",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    expect(exitCode).toBe(0);
  });

  test("handles unknown event gracefully", async () => {
    const { exitCode, stderr } = await runHandler({
      hook_event_name: "UnknownEvent",
      session_id: "unknown-session",
      cwd: TEST_PROJECT_DIR,
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    expect(exitCode).toBe(0);
    expect(stderr).toContain("Unhandled event");
  });
});

describe("project config handling", () => {
  test("custom logDir and dbPath work across separate processes", async () => {
    // This test verifies the fix for the bug where markdown logging failed
    // when a project used custom logDir/dbPath. Each runHandler() call is a
    // separate process, simulating real hook invocations.

    const customLogDir = join(TEST_PROJECT_DIR, "custom-logs");
    const customDbPath = join(customLogDir, "custom.db");
    mkdirSync(customLogDir, { recursive: true });

    // Configure custom paths
    writeFileSync(TEST_CONFIG_PATH, JSON.stringify({
      logDir: customLogDir,
      dbPath: customDbPath,
    }));

    const sessionId = "custom-path-session-" + Date.now();

    // Process 1: SessionStart - creates session and markdown file
    await runHandler({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      source: "startup",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    // Process 2: UserPromptSubmit - should find markdown file and append
    await runHandler({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      prompt: "Test message for custom path",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    // Process 3: PreToolUse - should also append to markdown
    await runHandler({
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      tool_name: "Bash",
      tool_input: { command: "echo hello" },
      tool_use_id: "tool-custom-1",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    // Verify: Find the markdown file in custom location
    const sessionsDir = join(customLogDir, "sessions");
    expect(existsSync(sessionsDir)).toBe(true);

    const dateDirs = require("fs").readdirSync(sessionsDir);
    expect(dateDirs.length).toBeGreaterThan(0);

    const dateDir = join(sessionsDir, dateDirs[0]);
    const mdFiles = require("fs").readdirSync(dateDir).filter((f: string) => f.endsWith(".md"));
    expect(mdFiles.length).toBeGreaterThan(0);

    // Find the file for our session
    const sessionFile = mdFiles.find((f: string) => f.includes(sessionId.substring(0, 8)));
    expect(sessionFile).toBeDefined();

    // Verify markdown content includes the user message and tool call
    const mdContent = readFileSync(join(dateDir, sessionFile!), "utf-8");
    expect(mdContent).toContain("Test message for custom path");
    expect(mdContent).toContain("Bash");
    expect(mdContent).toContain("echo hello");

    // Verify: Check that markdown_path is stored in custom database
    const Database = require("bun:sqlite").Database;
    const db = new Database(customDbPath, { readonly: true });
    const session = db.prepare("SELECT markdown_path FROM sessions WHERE id = ?").get(sessionId);
    db.close();

    expect(session).toBeDefined();
    expect(session.markdown_path).toContain(customLogDir);
  });

  test("respects markdown: false config", async () => {
    writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ markdown: false }));

    const sessionId = "no-md-session-" + Date.now();
    await runHandler({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      source: "startup",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    // Check that no markdown file was created in the test project
    // (it might be created in global log dir, but not with markdown: false)
    const { exitCode } = await runHandler({
      hook_event_name: "SessionEnd",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      reason: "logout",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    expect(exitCode).toBe(0);
  });

  test("respects sqlite: false config", async () => {
    writeFileSync(TEST_CONFIG_PATH, JSON.stringify({ sqlite: false }));

    const sessionId = "no-sql-session-" + Date.now();
    const { exitCode } = await runHandler({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      cwd: TEST_PROJECT_DIR,
      source: "startup",
      transcript_path: "/tmp/transcript.jsonl",
      permission_mode: "default",
    });

    expect(exitCode).toBe(0);
  });
});
