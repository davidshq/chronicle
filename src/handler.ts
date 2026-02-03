#!/usr/bin/env bun
/**
 * Claude Session Logger - Hook Handler
 *
 * This is the main entry point for the Claude Code hook.
 * It receives hook events via stdin and logs them to both
 * markdown files and a SQLite database.
 */

import { existsSync, copyFileSync, readFileSync, writeFileSync } from "fs";
import { join, basename } from "path";
import { debugLog, shouldExcludeProject, shouldExcludeTool, getConfig, getFailedEventsPath } from "./config";
import {
  createSession,
  updateSessionEnd,
  insertMessage,
  insertToolCall,
  updateToolCallSuccess,
  getSession,
  closeDatabase,
  insertEvent,
  insertTranscriptBackup,
  hasProjectSessions,
} from "./db";
import {
  initMarkdownFile,
  appendUserMessage,
  appendToolCall,
  appendToolResult,
  appendAssistantMessage,
  finalizeMarkdownFile,
  findExistingMarkdownFile,
  getActiveMarkdownPath,
  appendNotification,
  appendPermissionRequest,
  appendPreCompact,
  appendSubagentStop,
} from "./markdown";
import { getLatestAssistantResponse } from "./transcript";
import type {
  HookInput,
  SessionStartInput,
  SessionEndInput,
  UserPromptSubmitInput,
  PreToolUseInput,
  PostToolUseInput,
  StopInput,
  SubagentStopInput,
  NotificationInput,
  PermissionRequestInput,
  PreCompactInput,
  ToolInput,
} from "./types";

// Track tool call start times for duration calculation
const toolCallStartTimes = new Map<string, number>();

// Track last processed state per session to avoid duplicates
const sessionState = new Map<string, { lastAssistantContent?: string }>();

/**
 * Sleep for the specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Retry an async operation with configurable attempts and delay
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  options: { maxRetries: number; delayMs: number; operationName: string }
): Promise<T> {
  let lastError: Error | unknown;

  for (let attempt = 1; attempt <= options.maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const errorMessage = error instanceof Error ? error.message : String(error);

      if (attempt < options.maxRetries) {
        console.error(
          `[claude-remember] ${options.operationName} failed (attempt ${attempt}/${options.maxRetries}): ${errorMessage}`
        );
        console.error(`[claude-remember] Retrying in ${options.delayMs / 1000}s...`);
        await sleep(options.delayMs);
      }
    }
  }

  throw lastError;
}

/**
 * Store a failed event for manual retry later
 */
interface FailedEvent {
  timestamp: string;
  event: HookInput;
  error: string;
  attempts: number;
}

function storeFailedEvent(event: HookInput, error: string, attempts: number): void {
  const failedEventsPath = getFailedEventsPath();
  let failedEvents: FailedEvent[] = [];

  // Load existing failed events
  if (existsSync(failedEventsPath)) {
    try {
      const content = readFileSync(failedEventsPath, "utf-8");
      failedEvents = JSON.parse(content);
    } catch {
      // Ignore parse errors, start fresh
    }
  }

  // Add new failed event
  failedEvents.push({
    timestamp: new Date().toISOString(),
    event,
    error,
    attempts,
  });

  // Keep only last 100 failed events to prevent unbounded growth
  if (failedEvents.length > 100) {
    failedEvents = failedEvents.slice(-100);
  }

  writeFileSync(failedEventsPath, JSON.stringify(failedEvents, null, 2));
  debugLog("Stored failed event for retry:", event.hook_event_name);
}

/**
 * Retry failed events when user types "retry remember logging"
 */
async function retryFailedEventsFromPrompt(): Promise<string> {
  const failedEventsPath = getFailedEventsPath();

  if (!existsSync(failedEventsPath)) {
    return "[Claude Remember] No failed events found. Everything is logged successfully!";
  }

  let failedEvents: FailedEvent[];
  try {
    const content = readFileSync(failedEventsPath, "utf-8");
    failedEvents = JSON.parse(content);
  } catch {
    return "[Claude Remember] Could not read failed events file.";
  }

  if (failedEvents.length === 0) {
    return "[Claude Remember] No failed events to retry. Everything is logged successfully!";
  }

  let successCount = 0;
  let failCount = 0;
  const stillFailed: FailedEvent[] = [];

  for (const failedEvent of failedEvents) {
    // Use project-specific config for each event
    const eventConfig = getEffectiveConfig(failedEvent.event.cwd);

    try {
      await withRetry(
        () => processEvent(failedEvent.event as HookInput),
        {
          maxRetries: eventConfig.maxRetries,
          delayMs: eventConfig.retryDelayMs,
          operationName: `Retry ${failedEvent.event.hook_event_name}`,
        }
      );
      successCount++;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      failCount++;
      stillFailed.push({
        ...failedEvent,
        attempts: failedEvent.attempts + eventConfig.maxRetries,
        error: errorMessage,
      });
    }
  }

  // Update the failed events file
  writeFileSync(failedEventsPath, JSON.stringify(stillFailed, null, 2));

  if (stillFailed.length > 0) {
    return `[Claude Remember] Retry complete: ${successCount} succeeded, ${failCount} still failing. Say "retry remember logging" again later.`;
  }

  return `[Claude Remember] Retry complete: ${successCount} event(s) logged successfully!`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function getInterface(): "cli" | "vscode" | "web" {
  const isRemote = process.env.CLAUDE_CODE_REMOTE === "true";
  return isRemote ? "vscode" : "cli";
}

interface HookOutput {
  result?: string;
  continue?: boolean;
}

const PROJECT_CONFIG_FILE = ".claude-remember.json";

interface ProjectConfig {
  enabled?: boolean;
  logDir?: string;
  dbPath?: string;           // custom SQLite database path
  markdown?: boolean;        // default true
  sqlite?: boolean;          // default true
  // All global config options can be overridden per-project
  blockOnFailure?: boolean;  // override global blockOnFailure
  maxRetries?: number;       // override global maxRetries
  retryDelayMs?: number;     // override global retryDelayMs
  maxSearchDays?: number;    // override global maxSearchDays
  includeToolOutputs?: boolean;
  maxToolOutputLength?: number;
  debug?: boolean;
}

function getProjectConfig(projectPath: string): ProjectConfig | null {
  const configPath = join(projectPath, PROJECT_CONFIG_FILE);
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    const content = readFileSync(configPath, "utf-8");
    return JSON.parse(content) as ProjectConfig;
  } catch (e) {
    debugLog("Failed to parse project config:", e);
    return null;
  }
}

function disableProjectLogging(projectPath: string): void {
  const configPath = join(projectPath, PROJECT_CONFIG_FILE);
  const config: ProjectConfig = { enabled: false };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  debugLog("Disabled logging for project:", projectPath);
}

function enableProjectLogging(projectPath: string): void {
  const configPath = join(projectPath, PROJECT_CONFIG_FILE);
  const config: ProjectConfig = { enabled: true };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  debugLog("Enabled logging for project:", projectPath);
}

/**
 * Check if this project needs first-time setup.
 * Returns true if:
 * - No .claude-remember.json config file exists
 * - No sessions exist in the global database for this project
 *
 * This implements opt-in consent: new projects must explicitly enable logging.
 */
function isFirstTimeSetup(projectPath: string): boolean {
  // If config file exists, setup has been done (user made a choice)
  const config = getProjectConfig(projectPath);
  if (config !== null) {
    return false;
  }

  // No config file - check if we have any existing sessions in the global DB
  // This handles the upgrade path: existing users who have been logging
  // will continue without being prompted again
  try {
    const hasExisting = hasProjectSessions(projectPath, null); // null = use global DB
    return !hasExisting;
  } catch {
    // If we can't check the DB, assume first-time setup to be safe
    return true;
  }
}

function isProjectLoggingEnabled(projectPath: string): boolean {
  const config = getProjectConfig(projectPath);
  // If no config, check if it's first-time setup (needs opt-in)
  if (config === null) {
    // If first-time setup, logging is NOT enabled until user opts in
    if (isFirstTimeSetup(projectPath)) {
      return false;
    }
    // Has existing sessions but no config = legacy user, continue logging
    return true;
  }
  return config.enabled !== false;
}

function getProjectLogDir(projectPath: string): string | null {
  const config = getProjectConfig(projectPath);
  return config?.logDir || null;
}

function isMarkdownEnabled(projectPath: string): boolean {
  const config = getProjectConfig(projectPath);
  return config?.markdown !== false; // default true
}

function isSqliteEnabled(projectPath: string): boolean {
  const config = getProjectConfig(projectPath);
  return config?.sqlite !== false; // default true
}

function getProjectDbPath(projectPath: string): string | null {
  const config = getProjectConfig(projectPath);
  return config?.dbPath || null;
}

/**
 * Get effective config for a project - merges project config over global config.
 * Project-level settings override global settings.
 */
function getEffectiveConfig(projectPath: string): ReturnType<typeof getConfig> {
  const globalConfig = getConfig();
  const projectConfig = getProjectConfig(projectPath);

  if (!projectConfig) {
    return globalConfig;
  }

  return {
    ...globalConfig,
    // Override with project-specific values if defined
    blockOnFailure: projectConfig.blockOnFailure ?? globalConfig.blockOnFailure,
    maxRetries: projectConfig.maxRetries ?? globalConfig.maxRetries,
    retryDelayMs: projectConfig.retryDelayMs ?? globalConfig.retryDelayMs,
    maxSearchDays: projectConfig.maxSearchDays ?? globalConfig.maxSearchDays,
    includeToolOutputs: projectConfig.includeToolOutputs ?? globalConfig.includeToolOutputs,
    maxToolOutputLength: projectConfig.maxToolOutputLength ?? globalConfig.maxToolOutputLength,
    debug: projectConfig.debug ?? globalConfig.debug,
    // These are already handled by other functions but include for completeness
    logDir: projectConfig.logDir ?? globalConfig.logDir,
    dbPath: projectConfig.dbPath ?? globalConfig.dbPath,
  };
}

async function handleSessionStart(input: SessionStartInput): Promise<HookOutput | void> {
  const { session_id, cwd, source } = input;

  debugLog("SessionStart:", session_id, source);

  if (shouldExcludeProject(cwd)) {
    debugLog("Project excluded:", cwd);
    return;
  }

  // Check if this is a first-time setup (no config, no existing sessions)
  // Show setup prompt and don't log until user explicitly opts in
  if (isFirstTimeSetup(cwd)) {
    const projectName = basename(cwd);
    debugLog("First-time setup for project:", projectName);
    return {
      result: `[Claude Remember] Session logging is available for "${projectName}". To enable logging, say "enable remember logging". To disable this prompt, say "disable remember logging".`,
    };
  }

  // Check project-level config (user explicitly disabled)
  if (!isProjectLoggingEnabled(cwd)) {
    debugLog("Logging disabled for project:", cwd);
    return;
  }

  // Get config options
  const customLogDir = getProjectLogDir(cwd);
  const customDbPath = getProjectDbPath(cwd);
  const sqliteEnabled = isSqliteEnabled(cwd);
  const markdownEnabled = isMarkdownEnabled(cwd);

  const timestamp = new Date().toISOString();
  const interfaceType = getInterface();

  // Check if session already exists (resume case)
  if (sqliteEnabled) {
    const existing = getSession(session_id, customDbPath);
    if (existing) {
      debugLog("Resuming existing session:", session_id);
      if (markdownEnabled) {
        findExistingMarkdownFile(session_id, cwd, customLogDir, customDbPath);
      }
      return;
    }

    // Create new session in database
    createSession({
      id: session_id,
      project_path: cwd,
      started_at: timestamp,
      status: "active",
      interface: interfaceType,
    }, customDbPath);
  }

  // Initialize markdown file (with custom log dir and db path if configured)
  if (markdownEnabled) {
    initMarkdownFile(session_id, cwd, timestamp, source, customLogDir, customDbPath);
  }

  // Initialize session state
  sessionState.set(session_id, {});
}

async function handleSessionEnd(input: SessionEndInput): Promise<void> {
  const { session_id, reason, cwd } = input;

  debugLog("SessionEnd:", session_id, reason);

  const customDbPath = getProjectDbPath(cwd);

  // Update database
  if (isSqliteEnabled(cwd)) {
    updateSessionEnd(session_id, reason, customDbPath);
  }

  // Finalize markdown
  if (isMarkdownEnabled(cwd)) {
    const status = reason === "logout" || reason === "prompt_input_exit" ? "Completed" : "Interrupted";
    finalizeMarkdownFile(session_id, status, cwd);
  }

  // Cleanup state
  sessionState.delete(session_id);
  // Note: Database is closed in main() finally block
}

async function handleUserPromptSubmit(input: UserPromptSubmitInput): Promise<HookOutput | void> {
  const { session_id, prompt, cwd } = input;

  debugLog("UserPromptSubmit:", session_id);

  if (shouldExcludeProject(cwd)) {
    return;
  }

  // Check for special commands (case-insensitive)
  // Supports both natural language and slash command formats
  const lowerPrompt = prompt.toLowerCase().trim();

  // Disable logging command
  if (lowerPrompt === "disable remember logging" ||
      lowerPrompt === "/claude-remember:disable" ||
      lowerPrompt === "/remember:disable") {
    disableProjectLogging(cwd);
    const projectName = basename(cwd);
    return {
      result: `[Claude Remember] Session logging has been disabled for "${projectName}". A .claude-remember.json file was created. Delete it to re-enable logging.`,
    };
  }

  // Retry failed events command
  if (lowerPrompt === "retry remember logging" ||
      lowerPrompt === "/claude-remember:retry" ||
      lowerPrompt === "/remember:retry") {
    const result = await retryFailedEventsFromPrompt();
    return { result };
  }

  // Enable logging command
  if (lowerPrompt === "enable remember logging" ||
      lowerPrompt === "/claude-remember:enable" ||
      lowerPrompt === "/remember:enable") {
    const projectName = basename(cwd);
    const wasFirstTimeSetup = isFirstTimeSetup(cwd);

    // Create/update config to enable logging
    enableProjectLogging(cwd);

    // If this was first-time setup, initialize session for current session
    if (wasFirstTimeSetup) {
      const timestamp = new Date().toISOString();
      const interfaceType = getInterface();
      const customLogDir = getProjectLogDir(cwd);
      const customDbPath = getProjectDbPath(cwd);
      const sqliteEnabled = isSqliteEnabled(cwd);
      const markdownEnabled = isMarkdownEnabled(cwd);

      // Create session in database
      if (sqliteEnabled) {
        createSession({
          id: session_id,
          project_path: cwd,
          started_at: timestamp,
          status: "active",
          interface: interfaceType,
        }, customDbPath);
      }

      // Initialize markdown file
      if (markdownEnabled) {
        initMarkdownFile(session_id, cwd, timestamp, "user_enabled", customLogDir, customDbPath);
      }

      // Initialize session state
      sessionState.set(session_id, {});

      return {
        result: `[Claude Remember] Session logging has been enabled for "${projectName}". This session is now being logged to ~/.claude-logs/.`,
      };
    }

    return {
      result: `[Claude Remember] Session logging has been re-enabled for "${projectName}".`,
    };
  }

  // Check if logging is enabled
  if (!isProjectLoggingEnabled(cwd)) {
    return;
  }

  const timestamp = new Date().toISOString();
  const customDbPath = getProjectDbPath(cwd);
  const sqliteEnabled = isSqliteEnabled(cwd);
  const markdownEnabled = isMarkdownEnabled(cwd);

  // Ensure session exists
  ensureSession(input);

  // Insert into database
  if (sqliteEnabled) {
    insertMessage({
      session_id,
      timestamp,
      role: "user",
      content: prompt,
      tool_name: null,
      tool_input: null,
      tool_output: null,
    }, customDbPath);
  }

  // Append to markdown
  if (markdownEnabled) {
    appendUserMessage(session_id, timestamp, prompt);
  }
}

async function handlePreToolUse(input: PreToolUseInput): Promise<void> {
  const { session_id, tool_name, tool_input, tool_use_id, cwd } = input;

  debugLog("PreToolUse:", tool_name);

  if (shouldExcludeProject(cwd) || shouldExcludeTool(tool_name) || !isProjectLoggingEnabled(cwd)) {
    return;
  }

  const timestamp = new Date().toISOString();
  const customDbPath = getProjectDbPath(cwd);
  const sqliteEnabled = isSqliteEnabled(cwd);
  const markdownEnabled = isMarkdownEnabled(cwd);

  // Ensure session exists
  ensureSession(input);

  // Track start time for duration calculation
  toolCallStartTimes.set(tool_use_id, Date.now());

  // Get input summary
  const inputSummary = getToolInputSummary(tool_name, tool_input);

  // Insert tool call record
  if (sqliteEnabled) {
    insertToolCall({
      session_id,
      message_id: null,
      timestamp,
      tool_name,
      input_summary: inputSummary,
      success: null,
      duration_ms: null,
    }, customDbPath);
  }

  // Append to markdown
  if (markdownEnabled) {
    appendToolCall(session_id, timestamp, tool_name, tool_input);
  }
}

async function handlePostToolUse(input: PostToolUseInput): Promise<void> {
  const { session_id, tool_name, tool_use_id, tool_response, cwd } = input;

  debugLog("PostToolUse:", tool_name);

  if (shouldExcludeProject(cwd) || shouldExcludeTool(tool_name) || !isProjectLoggingEnabled(cwd)) {
    return;
  }

  const customDbPath = getProjectDbPath(cwd);
  const sqliteEnabled = isSqliteEnabled(cwd);
  const markdownEnabled = isMarkdownEnabled(cwd);

  // Calculate duration
  const startTime = toolCallStartTimes.get(tool_use_id);
  const duration = startTime ? Date.now() - startTime : null;
  toolCallStartTimes.delete(tool_use_id);

  // Determine success
  const success = tool_response.success !== false && tool_response.exit_code !== 1;

  // Update tool call in database
  if (sqliteEnabled) {
    updateToolCallSuccess(session_id, tool_name, tool_use_id, success, duration, customDbPath);
  }

  // Format output for markdown
  if (markdownEnabled) {
    let output: string | null = null;
    if (tool_response) {
      if (typeof tool_response === "string") {
        output = tool_response;
      } else {
        output = JSON.stringify(tool_response, null, 2);
      }
    }
    appendToolResult(session_id, tool_name, success, output ?? undefined);
  }
}

async function handleStop(input: StopInput): Promise<void> {
  const { session_id, transcript_path, cwd } = input;

  debugLog("Stop:", session_id);

  if (shouldExcludeProject(cwd) || !isProjectLoggingEnabled(cwd)) {
    return;
  }

  const customDbPath = getProjectDbPath(cwd);
  const sqliteEnabled = isSqliteEnabled(cwd);
  const markdownEnabled = isMarkdownEnabled(cwd);

  // Ensure session exists
  ensureSession(input);

  const timestamp = new Date().toISOString();
  const state = sessionState.get(session_id) || {};

  // Get the latest assistant response from transcript
  const assistantResponse = getLatestAssistantResponse(transcript_path);

  if (assistantResponse && assistantResponse !== state.lastAssistantContent) {
    // Insert into database
    if (sqliteEnabled) {
      insertMessage({
        session_id,
        timestamp,
        role: "assistant",
        content: assistantResponse,
        tool_name: null,
        tool_input: null,
        tool_output: null,
      }, customDbPath);
    }

    // Append to markdown
    if (markdownEnabled) {
      appendAssistantMessage(session_id, timestamp, assistantResponse);
    }

    // Update state to avoid duplicates
    state.lastAssistantContent = assistantResponse;
    sessionState.set(session_id, state);
  }
}

function ensureSession(input: HookInput): void {
  const { session_id, cwd } = input;
  const customDbPath = getProjectDbPath(cwd);
  const customLogDir = getProjectLogDir(cwd);
  const sqliteEnabled = isSqliteEnabled(cwd);
  const markdownEnabled = isMarkdownEnabled(cwd);

  // Check if we have an active markdown file
  if (markdownEnabled) {
    const existingPath = getActiveMarkdownPath(session_id);
    if (existingPath) {
      return;
    }
  }

  // Check database for existing session
  if (sqliteEnabled) {
    const existing = getSession(session_id, customDbPath);
    if (existing) {
      // Try to find markdown file (pass custom paths for proper lookup)
      if (markdownEnabled) {
        findExistingMarkdownFile(session_id, cwd, customLogDir, customDbPath);
      }
      return;
    }
  }

  // Create new session (this can happen if SessionStart hook didn't fire)
  const timestamp = new Date().toISOString();

  if (sqliteEnabled) {
    createSession({
      id: session_id,
      project_path: cwd,
      started_at: timestamp,
      status: "active",
      interface: getInterface(),
    }, customDbPath);
  }

  if (markdownEnabled) {
    initMarkdownFile(session_id, cwd, timestamp, "hook", customLogDir, customDbPath);
  }

  sessionState.set(session_id, {});
}

function getToolInputSummary(toolName: string, input: ToolInput): string {
  // Type guard helper for safe property access
  const get = (key: string): string => {
    if (typeof input === "object" && input !== null && key in input) {
      const val = (input as Record<string, unknown>)[key];
      return typeof val === "string" ? val : "";
    }
    return "";
  };

  switch (toolName) {
    case "Bash":
      return get("command").substring(0, 100);
    case "Write":
    case "Read":
    case "Edit":
      return get("file_path");
    case "Glob":
      return get("pattern");
    case "Grep":
      return `${get("pattern")} in ${get("path") || "."}`;
    case "WebFetch":
      return get("url");
    case "WebSearch":
      return get("query");
    case "Task":
      return get("description");
    default:
      return JSON.stringify(input).substring(0, 100);
  }
}

async function handleSubagentStop(input: SubagentStopInput): Promise<void> {
  const { session_id, cwd } = input;

  debugLog("SubagentStop:", session_id);

  if (shouldExcludeProject(cwd) || !isProjectLoggingEnabled(cwd)) {
    return;
  }

  const customDbPath = getProjectDbPath(cwd);
  const sqliteEnabled = isSqliteEnabled(cwd);
  const markdownEnabled = isMarkdownEnabled(cwd);
  const timestamp = new Date().toISOString();

  // Ensure session exists
  ensureSession(input);

  // Insert event record
  if (sqliteEnabled) {
    insertEvent({
      session_id,
      timestamp,
      event_type: "subagent_stop",
      subtype: null,
      tool_name: null,
      message: null,
      metadata: null,
    }, customDbPath);
  }

  // Append to markdown
  if (markdownEnabled) {
    appendSubagentStop(session_id, timestamp);
  }
}

async function handleNotification(input: NotificationInput): Promise<void> {
  const { session_id, cwd, message, notification_type } = input;

  debugLog("Notification:", notification_type);

  if (shouldExcludeProject(cwd) || !isProjectLoggingEnabled(cwd)) {
    return;
  }

  const customDbPath = getProjectDbPath(cwd);
  const sqliteEnabled = isSqliteEnabled(cwd);
  const markdownEnabled = isMarkdownEnabled(cwd);
  const timestamp = new Date().toISOString();

  // Ensure session exists
  ensureSession(input);

  // Insert event record
  if (sqliteEnabled) {
    insertEvent({
      session_id,
      timestamp,
      event_type: "notification",
      subtype: notification_type,
      tool_name: null,
      message,
      metadata: null,
    }, customDbPath);
  }

  // Append to markdown
  if (markdownEnabled) {
    appendNotification(session_id, timestamp, notification_type, message);
  }
}

async function handlePermissionRequest(input: PermissionRequestInput): Promise<void> {
  const { session_id, cwd, tool_name, tool_input } = input;

  debugLog("PermissionRequest:", tool_name);

  if (shouldExcludeProject(cwd) || !isProjectLoggingEnabled(cwd)) {
    return;
  }

  const customDbPath = getProjectDbPath(cwd);
  const sqliteEnabled = isSqliteEnabled(cwd);
  const markdownEnabled = isMarkdownEnabled(cwd);
  const timestamp = new Date().toISOString();

  // Ensure session exists
  ensureSession(input);

  const inputSummary = getToolInputSummary(tool_name, tool_input);

  // Insert event record
  if (sqliteEnabled) {
    insertEvent({
      session_id,
      timestamp,
      event_type: "permission_request",
      subtype: null,
      tool_name,
      message: inputSummary,
      metadata: JSON.stringify(tool_input),
    }, customDbPath);
  }

  // Append to markdown
  if (markdownEnabled) {
    appendPermissionRequest(session_id, timestamp, tool_name, inputSummary);
  }
}

async function handlePreCompact(input: PreCompactInput): Promise<void> {
  const { session_id, cwd, transcript_path, trigger } = input;

  debugLog("PreCompact:", trigger);

  if (shouldExcludeProject(cwd) || !isProjectLoggingEnabled(cwd)) {
    return;
  }

  const customDbPath = getProjectDbPath(cwd);
  const customLogDir = getProjectLogDir(cwd);
  const sqliteEnabled = isSqliteEnabled(cwd);
  const markdownEnabled = isMarkdownEnabled(cwd);
  const timestamp = new Date().toISOString();
  const config = getConfig();

  // Ensure session exists
  ensureSession(input);

  // Backup the transcript before compaction
  // Use custom logDir for backups if configured, otherwise use global logDir
  let backupPath: string | null = null;
  if (existsSync(transcript_path)) {
    const baseDir = customLogDir || config.logDir;
    const backupDir = join(baseDir, "backups");
    const shortSessionId = session_id.substring(0, 8);
    const backupFilename = `${shortSessionId}_${timestamp.replace(/[:.]/g, "-")}.jsonl`;
    backupPath = join(backupDir, backupFilename);

    try {
      // Ensure backup directory exists
      const { mkdirSync } = await import("fs");
      mkdirSync(backupDir, { recursive: true });

      // Copy transcript to backup
      copyFileSync(transcript_path, backupPath);
      debugLog("Backed up transcript to:", backupPath);
    } catch (e) {
      debugLog("Failed to backup transcript:", e);
      backupPath = null;
    }
  }

  if (sqliteEnabled) {
    // Insert event record
    insertEvent({
      session_id,
      timestamp,
      event_type: "pre_compact",
      subtype: trigger,
      tool_name: null,
      message: backupPath ? `Backup: ${backupPath}` : "No backup created",
      metadata: null,
    }, customDbPath);

    // Insert transcript backup record
    insertTranscriptBackup({
      session_id,
      timestamp,
      trigger,
      transcript_path,
      backup_path: backupPath,
    }, customDbPath);
  }

  // Append to markdown
  if (markdownEnabled) {
    appendPreCompact(session_id, timestamp, trigger, backupPath || undefined);
  }
}

/**
 * Process a single hook event with retry logic
 */
async function processEvent(input: HookInput): Promise<HookOutput | undefined> {
  const eventName = input.hook_event_name;

  debugLog("Processing event:", eventName);

  switch (eventName) {
    case "SessionStart":
      return await handleSessionStart(input as SessionStartInput) || undefined;
    case "SessionEnd":
      await handleSessionEnd(input as SessionEndInput);
      return undefined;
    case "UserPromptSubmit":
      return await handleUserPromptSubmit(input as UserPromptSubmitInput) || undefined;
    case "PreToolUse":
      await handlePreToolUse(input as PreToolUseInput);
      return undefined;
    case "PostToolUse":
      await handlePostToolUse(input as PostToolUseInput);
      return undefined;
    case "Stop":
      await handleStop(input as StopInput);
      return undefined;
    case "SubagentStop":
      await handleSubagentStop(input as SubagentStopInput);
      return undefined;
    case "Notification":
      await handleNotification(input as NotificationInput);
      return undefined;
    case "PermissionRequest":
      await handlePermissionRequest(input as PermissionRequestInput);
      return undefined;
    case "PreCompact":
      await handlePreCompact(input as PreCompactInput);
      return undefined;
    default:
      debugLog("Unhandled event:", eventName);
      return undefined;
  }
}

async function main(): Promise<void> {
  // Start with global config, will get project-specific after parsing input
  let config = getConfig();
  let exitCode = 0;

  try {
    // Read hook input from stdin
    const stdinContent = await readStdin();
    if (!stdinContent.trim()) {
      debugLog("No stdin content received");
      return; // Will exit via finally block
    }

    const input: HookInput = JSON.parse(stdinContent);
    const eventName = input.hook_event_name;

    // Get project-specific config (overrides global settings)
    config = getEffectiveConfig(input.cwd);

    debugLog("Received event:", eventName);

    let output: HookOutput | undefined = undefined;

    try {
      // Process with retry if configured
      output = await withRetry(
        () => processEvent(input),
        {
          maxRetries: config.maxRetries,
          delayMs: config.retryDelayMs,
          operationName: `Logging ${eventName}`,
        }
      );
    } catch (error) {
      // All retries exhausted
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[claude-remember] Logging failed after ${config.maxRetries} attempts: ${errorMessage}`);

      // Store event for manual retry
      storeFailedEvent(input, errorMessage, config.maxRetries);

      if (config.blockOnFailure) {
        // User configured to block Claude on failure
        console.error("[claude-remember] blockOnFailure is enabled. Say 'retry remember logging' to retry failed events.");
        // Output failure message to Claude
        console.log(JSON.stringify({
          result: `[Claude Remember] Logging failed after ${config.maxRetries} attempts. Say "retry remember logging" to retry, or check ~/.claude-logs/.failed-events.json`,
        }));
        exitCode = 1; // Non-zero exit blocks the hook
      } else {
        // Fail-safe mode: warn but don't block
        console.error("[claude-remember] Continuing despite failure (blockOnFailure=false).");
      }
    }

    // Output hook result if there is one
    if (output) {
      console.log(JSON.stringify(output));
    }
  } catch (error) {
    // Parse error or other critical failure
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("[claude-remember] Critical error:", errorMessage);

    if (config.blockOnFailure) {
      exitCode = 1;
    }
  } finally {
    // CRITICAL: Always close the database before exiting
    // This ensures WAL checkpoints are written and locks are released
    closeDatabase();
    process.exit(exitCode);
  }
}

main();
