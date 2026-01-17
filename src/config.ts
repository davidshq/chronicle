import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync } from "fs";
import type { Config } from "./types";

const DEFAULT_LOG_DIR = join(homedir(), ".claude-logs");
const CONFIG_FILE = join(DEFAULT_LOG_DIR, "config.json");

const DEFAULT_CONFIG: Config = {
  logDir: DEFAULT_LOG_DIR,
  dbPath: join(DEFAULT_LOG_DIR, "sessions.db"),
  includeToolOutputs: true,
  maxToolOutputLength: 2000,
  enableWAL: true,
  excludeTools: [],
  excludeProjects: [],
  debug: false,
  // Retry and failure handling defaults
  blockOnFailure: false,  // Default: fail-safe, don't block Claude
  maxRetries: 3,          // Try 3 times before giving up
  retryDelayMs: 2000,     // 2 seconds between retries
  // Performance
  maxSearchDays: 7,       // Only search last 7 days for session files
};

let cachedConfig: Config | null = null;

export function getConfig(): Config {
  if (cachedConfig) {
    return cachedConfig;
  }

  // Ensure log directory exists
  if (!existsSync(DEFAULT_LOG_DIR)) {
    mkdirSync(DEFAULT_LOG_DIR, { recursive: true });
  }

  // Load config file if it exists
  let userConfig: Partial<Config> = {};
  if (existsSync(CONFIG_FILE)) {
    try {
      const content = readFileSync(CONFIG_FILE, "utf-8");
      userConfig = JSON.parse(content);
    } catch (e) {
      // Ignore parse errors, use defaults
      console.error("Failed to parse config file:", e);
    }
  }

  cachedConfig = {
    ...DEFAULT_CONFIG,
    ...userConfig,
    // Ensure paths are absolute
    logDir: userConfig.logDir || DEFAULT_CONFIG.logDir,
    dbPath: userConfig.dbPath || DEFAULT_CONFIG.dbPath,
  };

  // Ensure sessions directory exists
  const sessionsDir = join(cachedConfig.logDir, "sessions");
  if (!existsSync(sessionsDir)) {
    mkdirSync(sessionsDir, { recursive: true });
  }

  return cachedConfig;
}

export function getSessionsDir(): string {
  return join(getConfig().logDir, "sessions");
}

export function getDateDir(date: Date = new Date()): string {
  const dateStr = date.toLocaleDateString("en-CA"); // YYYY-MM-DD in local timezone
  const dir = join(getSessionsDir(), dateStr);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function shouldExcludeProject(projectPath: string): boolean {
  const config = getConfig();
  return config.excludeProjects.some(
    (excluded) => projectPath.includes(excluded) || projectPath.startsWith(excluded)
  );
}

export function shouldExcludeTool(toolName: string): boolean {
  const config = getConfig();
  return config.excludeTools.includes(toolName);
}

export function debugLog(...args: unknown[]): void {
  if (getConfig().debug) {
    console.error("[claude-session-logger]", ...args);
  }
}

/**
 * Get the path to the failed events file for manual retry
 */
export function getFailedEventsPath(): string {
  return join(getConfig().logDir, ".failed-events.json");
}
