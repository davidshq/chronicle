import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, existsSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import {
  getDatabase,
  closeDatabase,
  createSession,
  getSession,
  updateSessionEnd,
  updateSessionMarkdownPath,
  getSessionMarkdownPath,
  insertMessage,
  getSessionMessages,
  insertToolCall,
  updateToolCallSuccess,
  getToolUsageStats,
  getRecentSessions,
  insertEvent,
  getSessionEvents,
  hasProjectSessions,
} from "../db";

const TEST_DB_PATH = join(import.meta.dir, ".test-sessions.db");

beforeEach(() => {
  // Clean up any existing test database
  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }
  if (existsSync(TEST_DB_PATH + "-wal")) {
    unlinkSync(TEST_DB_PATH + "-wal");
  }
  if (existsSync(TEST_DB_PATH + "-shm")) {
    unlinkSync(TEST_DB_PATH + "-shm");
  }
});

afterEach(() => {
  closeDatabase();
  // Clean up test database
  if (existsSync(TEST_DB_PATH)) {
    unlinkSync(TEST_DB_PATH);
  }
  if (existsSync(TEST_DB_PATH + "-wal")) {
    unlinkSync(TEST_DB_PATH + "-wal");
  }
  if (existsSync(TEST_DB_PATH + "-shm")) {
    unlinkSync(TEST_DB_PATH + "-shm");
  }
});

describe("database initialization", () => {
  test("creates database file", () => {
    getDatabase(TEST_DB_PATH);
    expect(existsSync(TEST_DB_PATH)).toBe(true);
  });

  test("returns same instance for same path", () => {
    const db1 = getDatabase(TEST_DB_PATH);
    const db2 = getDatabase(TEST_DB_PATH);
    expect(db1).toBe(db2);
  });

  test("sets busy_timeout PRAGMA for concurrent access", () => {
    const db = getDatabase(TEST_DB_PATH);
    const result = db.query("PRAGMA busy_timeout").get() as { timeout: number };
    // Must be set to a reasonable value (we use 5000ms)
    expect(result.timeout).toBeGreaterThanOrEqual(5000);
  });

  test("enables WAL mode by default", () => {
    const db = getDatabase(TEST_DB_PATH);
    const result = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(result.journal_mode.toLowerCase()).toBe("wal");
  });

  test("sets synchronous to NORMAL with WAL mode", () => {
    const db = getDatabase(TEST_DB_PATH);
    // NORMAL = 1, FULL = 2, OFF = 0
    const result = db.query("PRAGMA synchronous").get() as { synchronous: number };
    expect(result.synchronous).toBe(1); // NORMAL
  });
});

describe("session operations", () => {
  test("creates and retrieves session", () => {
    createSession({
      id: "test-session-1",
      project_path: "/test/project",
      started_at: "2026-01-16T10:00:00Z",
      status: "active",
      interface: "cli",
    }, TEST_DB_PATH);

    const session = getSession("test-session-1", TEST_DB_PATH);

    expect(session).not.toBeNull();
    expect(session!.id).toBe("test-session-1");
    expect(session!.project_path).toBe("/test/project");
    expect(session!.status).toBe("active");
    expect(session!.interface).toBe("cli");
  });

  test("returns null for non-existent session", () => {
    getDatabase(TEST_DB_PATH); // Initialize DB
    const session = getSession("non-existent", TEST_DB_PATH);
    expect(session).toBeNull();
  });

  test("updates session end", () => {
    createSession({
      id: "test-session-2",
      project_path: "/test/project",
      started_at: "2026-01-16T10:00:00Z",
      status: "active",
      interface: "cli",
    }, TEST_DB_PATH);

    updateSessionEnd("test-session-2", "logout", TEST_DB_PATH);

    const session = getSession("test-session-2", TEST_DB_PATH);
    expect(session!.status).toBe("completed");
    expect(session!.ended_at).not.toBeNull();
  });

  test("updates session markdown path", () => {
    createSession({
      id: "test-session-3",
      project_path: "/test/project",
      started_at: "2026-01-16T10:00:00Z",
      status: "active",
      interface: "cli",
    }, TEST_DB_PATH);

    updateSessionMarkdownPath("test-session-3", "/path/to/file.md", TEST_DB_PATH);

    const path = getSessionMarkdownPath("test-session-3", TEST_DB_PATH);
    expect(path).toBe("/path/to/file.md");
  });

  test("hasProjectSessions returns false for new project", () => {
    getDatabase(TEST_DB_PATH); // Initialize DB
    const result = hasProjectSessions("/new/project", TEST_DB_PATH);
    expect(result).toBe(false);
  });

  test("hasProjectSessions returns true after creating session", () => {
    createSession({
      id: "test-session-4",
      project_path: "/existing/project",
      started_at: "2026-01-16T10:00:00Z",
      status: "active",
      interface: "cli",
    }, TEST_DB_PATH);

    const result = hasProjectSessions("/existing/project", TEST_DB_PATH);
    expect(result).toBe(true);
  });

  test("getRecentSessions returns sessions in descending order", () => {
    createSession({
      id: "old-session",
      project_path: "/test",
      started_at: "2026-01-15T10:00:00Z",
      status: "completed",
      interface: "cli",
    }, TEST_DB_PATH);

    createSession({
      id: "new-session",
      project_path: "/test",
      started_at: "2026-01-16T10:00:00Z",
      status: "active",
      interface: "cli",
    }, TEST_DB_PATH);

    const sessions = getRecentSessions(10, TEST_DB_PATH);

    expect(sessions).toHaveLength(2);
    expect(sessions[0].id).toBe("new-session");
    expect(sessions[1].id).toBe("old-session");
  });
});

describe("message operations", () => {
  beforeEach(() => {
    createSession({
      id: "msg-test-session",
      project_path: "/test",
      started_at: "2026-01-16T10:00:00Z",
      status: "active",
      interface: "cli",
    }, TEST_DB_PATH);
  });

  test("inserts and retrieves messages", () => {
    insertMessage({
      session_id: "msg-test-session",
      timestamp: "2026-01-16T10:00:00Z",
      role: "user",
      content: "Hello",
      tool_name: null,
      tool_input: null,
      tool_output: null,
    }, TEST_DB_PATH);

    insertMessage({
      session_id: "msg-test-session",
      timestamp: "2026-01-16T10:00:01Z",
      role: "assistant",
      content: "Hi there!",
      tool_name: null,
      tool_input: null,
      tool_output: null,
    }, TEST_DB_PATH);

    const messages = getSessionMessages("msg-test-session", TEST_DB_PATH);

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Hi there!");
  });

  test("increments message count on insert", () => {
    insertMessage({
      session_id: "msg-test-session",
      timestamp: "2026-01-16T10:00:00Z",
      role: "user",
      content: "Test",
      tool_name: null,
      tool_input: null,
      tool_output: null,
    }, TEST_DB_PATH);

    const session = getSession("msg-test-session", TEST_DB_PATH);
    expect(session!.message_count).toBe(1);
  });
});

describe("tool call operations", () => {
  beforeEach(() => {
    createSession({
      id: "tool-test-session",
      project_path: "/test",
      started_at: "2026-01-16T10:00:00Z",
      status: "active",
      interface: "cli",
    }, TEST_DB_PATH);
  });

  test("inserts tool call", () => {
    const id = insertToolCall({
      session_id: "tool-test-session",
      message_id: null,
      timestamp: "2026-01-16T10:00:00Z",
      tool_name: "Read",
      input_summary: "/path/to/file.txt",
      success: null,
      duration_ms: null,
    }, TEST_DB_PATH);

    expect(id).toBeGreaterThan(0);
  });

  test("updates tool call success and duration", () => {
    insertToolCall({
      session_id: "tool-test-session",
      message_id: null,
      timestamp: "2026-01-16T10:00:00Z",
      tool_name: "Bash",
      input_summary: "ls -la",
      success: null,
      duration_ms: null,
    }, TEST_DB_PATH);

    updateToolCallSuccess("tool-test-session", "Bash", "tool-1", true, 150, TEST_DB_PATH);

    const stats = getToolUsageStats("tool-test-session", TEST_DB_PATH);
    expect(stats).toHaveLength(1);
    expect(stats[0].tool_name).toBe("Bash");
    expect(stats[0].success_rate).toBe(100);
  });

  test("getToolUsageStats returns aggregated stats", () => {
    // Insert multiple tool calls
    for (let i = 0; i < 3; i++) {
      insertToolCall({
        session_id: "tool-test-session",
        message_id: null,
        timestamp: `2026-01-16T10:00:0${i}Z`,
        tool_name: "Read",
        input_summary: `/file${i}.txt`,
        success: 1,
        duration_ms: 100,
      }, TEST_DB_PATH);
    }

    insertToolCall({
      session_id: "tool-test-session",
      message_id: null,
      timestamp: "2026-01-16T10:00:10Z",
      tool_name: "Write",
      input_summary: "/output.txt",
      success: 1,
      duration_ms: 200,
    }, TEST_DB_PATH);

    const stats = getToolUsageStats(undefined, TEST_DB_PATH);

    expect(stats).toHaveLength(2);
    const readStats = stats.find(s => s.tool_name === "Read");
    expect(readStats!.count).toBe(3);
  });
});

describe("event operations", () => {
  beforeEach(() => {
    createSession({
      id: "event-test-session",
      project_path: "/test",
      started_at: "2026-01-16T10:00:00Z",
      status: "active",
      interface: "cli",
    }, TEST_DB_PATH);
  });

  test("inserts and retrieves events", () => {
    insertEvent({
      session_id: "event-test-session",
      timestamp: "2026-01-16T10:00:00Z",
      event_type: "notification",
      subtype: "permission_prompt",
      tool_name: null,
      message: "Allow bash command?",
      metadata: null,
    }, TEST_DB_PATH);

    insertEvent({
      session_id: "event-test-session",
      timestamp: "2026-01-16T10:00:01Z",
      event_type: "pre_compact",
      subtype: "auto",
      tool_name: null,
      message: "Context compaction triggered",
      metadata: null,
    }, TEST_DB_PATH);

    const events = getSessionEvents("event-test-session", TEST_DB_PATH);

    expect(events).toHaveLength(2);
    expect(events[0].event_type).toBe("notification");
    expect(events[1].event_type).toBe("pre_compact");
  });
});

describe("concurrent access", () => {
  const TEST_PROJECT_DIR = join(import.meta.dir, ".test-concurrent-project");
  const CONCURRENT_DB_PATH = join(TEST_PROJECT_DIR, "test.db");
  const CONCURRENT_LOG_DIR = join(TEST_PROJECT_DIR, "logs");

  beforeEach(() => {
    // Create test project directory with config
    mkdirSync(TEST_PROJECT_DIR, { recursive: true });
    mkdirSync(CONCURRENT_LOG_DIR, { recursive: true });

    // Create project config that redirects DB to our test location
    writeFileSync(
      join(TEST_PROJECT_DIR, ".claude-remember.json"),
      JSON.stringify({
        enabled: true,
        dbPath: CONCURRENT_DB_PATH,
        logDir: CONCURRENT_LOG_DIR,
        markdown: false,  // Disable markdown to focus on DB testing
      })
    );
  });

  afterEach(() => {
    // Clean up entire test directory
    if (existsSync(TEST_PROJECT_DIR)) {
      rmSync(TEST_PROJECT_DIR, { recursive: true, force: true });
    }
  });

  test("handles multiple concurrent writes without corruption", async () => {
    // This test spawns multiple processes that write to the same database
    // simultaneously, simulating the real hook scenario
    const PROCESS_COUNT = 5;
    const handlerPath = join(import.meta.dir, "..", "handler.ts");

    // Create the session first so concurrent writes have something to reference
    const initEvent = JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "concurrent-test-session",
      cwd: TEST_PROJECT_DIR,
      source: "startup",
    });

    const initProc = Bun.spawn(["bun", "run", handlerPath], {
      stdin: new Blob([initEvent]),
      stdout: "pipe",
      stderr: "pipe",
    });
    await initProc.exited;

    // Now spawn multiple concurrent processes
    const processes = [];
    for (let i = 0; i < PROCESS_COUNT; i++) {
      const event = JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "concurrent-test-session",
        cwd: TEST_PROJECT_DIR,
        tool_name: `ConcurrentTool${i}`,
        tool_input: { index: i },
      });

      const proc = Bun.spawn(["bun", "run", handlerPath], {
        stdin: new Blob([event]),
        stdout: "pipe",
        stderr: "pipe",
      });
      processes.push(proc);
    }

    // Wait for all processes to complete
    const exitCodes = await Promise.all(processes.map(p => p.exited));

    // All processes should exit successfully (code 0)
    for (let i = 0; i < exitCodes.length; i++) {
      expect(exitCodes[i]).toBe(0);
    }

    // Verify the database is not corrupted
    const { Database } = await import("bun:sqlite");
    const db = new Database(CONCURRENT_DB_PATH, { readonly: true });
    const integrityResult = db.query("PRAGMA integrity_check").get() as { integrity_check: string };
    expect(integrityResult.integrity_check).toBe("ok");

    // Verify all tool calls were recorded
    const toolCalls = db.query("SELECT COUNT(*) as count FROM tool_calls WHERE session_id = ?").get("concurrent-test-session") as { count: number };
    expect(toolCalls.count).toBe(PROCESS_COUNT);

    db.close();
  }, 30000); // 30 second timeout for this test
});
