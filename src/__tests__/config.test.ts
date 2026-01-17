import { describe, test, expect } from "bun:test";
import {
  getConfig,
  shouldExcludeProject,
  shouldExcludeTool,
  getSessionsDir,
  getDateDir,
} from "../config";

describe("getConfig", () => {
  test("returns config object with required fields", () => {
    const config = getConfig();

    expect(config).toHaveProperty("logDir");
    expect(config).toHaveProperty("dbPath");
    expect(config).toHaveProperty("includeToolOutputs");
    expect(config).toHaveProperty("maxToolOutputLength");
    expect(config).toHaveProperty("enableWAL");
    expect(config).toHaveProperty("excludeTools");
    expect(config).toHaveProperty("excludeProjects");
    expect(config).toHaveProperty("debug");
  });

  test("returns same instance on subsequent calls", () => {
    const config1 = getConfig();
    const config2 = getConfig();

    expect(config1).toBe(config2);
  });

  test("has sensible defaults", () => {
    const config = getConfig();

    expect(config.logDir).toContain(".claude-logs");
    expect(config.dbPath).toContain("sessions.db");
    expect(typeof config.includeToolOutputs).toBe("boolean");
    expect(typeof config.maxToolOutputLength).toBe("number");
    expect(config.maxToolOutputLength).toBeGreaterThan(0);
  });
});

describe("shouldExcludeProject", () => {
  test("returns false for non-excluded projects", () => {
    const result = shouldExcludeProject("/some/random/project");
    expect(result).toBe(false);
  });

  // Note: This test depends on the config not having exclusions
  // In a real scenario, we'd mock the config
  test("checks project path against exclusions", () => {
    const config = getConfig();
    // If there are no exclusions, all projects should be included
    if (config.excludeProjects.length === 0) {
      expect(shouldExcludeProject("/any/path")).toBe(false);
    }
  });
});

describe("shouldExcludeTool", () => {
  test("returns false for non-excluded tools", () => {
    const result = shouldExcludeTool("SomeRandomTool");
    expect(result).toBe(false);
  });

  test("checks tool name against exclusions", () => {
    const config = getConfig();
    // If there are no exclusions, all tools should be included
    if (config.excludeTools.length === 0) {
      expect(shouldExcludeTool("Bash")).toBe(false);
      expect(shouldExcludeTool("Read")).toBe(false);
    }
  });
});

describe("getSessionsDir", () => {
  test("returns path containing sessions", () => {
    const dir = getSessionsDir();
    expect(dir).toContain("sessions");
  });

  test("returns path under logDir", () => {
    const config = getConfig();
    const sessionsDir = getSessionsDir();
    expect(sessionsDir).toContain(config.logDir);
  });
});

describe("getDateDir", () => {
  test("returns path with date format", () => {
    const dir = getDateDir(new Date("2026-01-16T10:00:00Z"));
    // Should contain YYYY-MM-DD format
    expect(dir).toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test("uses current date when no argument provided", () => {
    const dir = getDateDir();
    const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD
    expect(dir).toContain(today);
  });

  test("returns path under sessions directory", () => {
    const sessionsDir = getSessionsDir();
    const dateDir = getDateDir();
    expect(dateDir).toContain(sessionsDir);
  });
});
