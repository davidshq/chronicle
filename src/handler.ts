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
import { debugLog, shouldExcludeProject, shouldExcludeTool, getConfig } from "./config";
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
  HookEventName,
} from "./types";

// Track tool call start times for duration calculation
const toolCallStartTimes = new Map<string, number>();

// Track last processed state per session to avoid duplicates
const sessionState = new Map<string, { lastAssistantContent?: string }>();

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
  dbPath?: string;     // custom SQLite database path
  markdown?: boolean;  // default true
  sqlite?: boolean;    // default true
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

function isProjectLoggingEnabled(projectPath: string): boolean {
  const config = getProjectConfig(projectPath);
  return config === null || config.enabled !== false;
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

async function handleSessionStart(input: SessionStartInput): Promise<HookOutput | void> {
  const { session_id, cwd, source } = input;

  debugLog("SessionStart:", session_id, source);

  if (shouldExcludeProject(cwd)) {
    debugLog("Project excluded:", cwd);
    return;
  }

  // Check project-level config
  if (!isProjectLoggingEnabled(cwd)) {
    debugLog("Logging disabled for project:", cwd);
    return;
  }

  // Get config options
  const customLogDir = getProjectLogDir(cwd);
  const customDbPath = getProjectDbPath(cwd);
  const sqliteEnabled = isSqliteEnabled(cwd);
  const markdownEnabled = isMarkdownEnabled(cwd);

  // Check if this is a new project (no previous sessions in sqlite)
  const isNewProject = sqliteEnabled ? !hasProjectSessions(cwd, customDbPath) : true;

  const timestamp = new Date().toISOString();
  const interfaceType = getInterface();

  // Check if session already exists (resume case)
  if (sqliteEnabled) {
    const existing = getSession(session_id, customDbPath);
    if (existing) {
      debugLog("Resuming existing session:", session_id);
      if (markdownEnabled) {
        findExistingMarkdownFile(session_id, cwd);
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

  // Initialize markdown file (with custom log dir if configured)
  if (markdownEnabled) {
    initMarkdownFile(session_id, cwd, timestamp, source, customLogDir);
  }

  // Initialize session state
  sessionState.set(session_id, {});

  // Show welcome message for new projects
  if (isNewProject) {
    const projectName = basename(cwd);
    const logLocation = customLogDir || customDbPath || "~/.claude-logs/";
    return {
      result: `[Claude Remember] Session logging is enabled for "${projectName}". Conversations are saved to ${logLocation}. To disable, say "disable remember logging".`,
    };
  }
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
  closeDatabase();
}

async function handleUserPromptSubmit(input: UserPromptSubmitInput): Promise<HookOutput | void> {
  const { session_id, prompt, cwd } = input;

  debugLog("UserPromptSubmit:", session_id);

  if (shouldExcludeProject(cwd)) {
    return;
  }

  // Check for disable command (case-insensitive)
  const lowerPrompt = prompt.toLowerCase().trim();
  if (lowerPrompt === "disable remember logging") {
    disableProjectLogging(cwd);
    const projectName = basename(cwd);
    return {
      result: `[Claude Remember] Session logging has been disabled for "${projectName}". A .claude-remember.json file was created. Delete it to re-enable logging.`,
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
    updateToolCallSuccess(session_id, tool_name, tool_use_id, success, customDbPath);
  }

  // Format output for markdown
  if (markdownEnabled) {
    let output: string | undefined;
    if (tool_response) {
      if (typeof tool_response === "string") {
        output = tool_response;
      } else {
        output = JSON.stringify(tool_response, null, 2);
      }
    }
    appendToolResult(session_id, tool_name, success, output);
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

  // Check if we have an active markdown file
  const existingPath = getActiveMarkdownPath(session_id);
  if (existingPath) {
    return;
  }

  // Check database
  const existing = getSession(session_id, customDbPath);
  if (existing) {
    // Try to find markdown file
    findExistingMarkdownFile(session_id, cwd);
    return;
  }

  // Create new session (this can happen if SessionStart hook didn't fire)
  const timestamp = new Date().toISOString();
  createSession({
    id: session_id,
    project_path: cwd,
    started_at: timestamp,
    status: "active",
    interface: getInterface(),
  }, customDbPath);

  initMarkdownFile(session_id, cwd, timestamp, "hook", customLogDir);
  sessionState.set(session_id, {});
}

function getToolInputSummary(toolName: string, input: any): string {
  switch (toolName) {
    case "Bash":
      return input.command?.substring(0, 100) || "";
    case "Write":
    case "Read":
    case "Edit":
      return input.file_path || "";
    case "Glob":
      return input.pattern || "";
    case "Grep":
      return `${input.pattern} in ${input.path || "."}`;
    case "WebFetch":
      return input.url || "";
    case "WebSearch":
      return input.query || "";
    case "Task":
      return input.description || "";
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

async function main(): Promise<void> {
  try {
    // Read hook input from stdin
    const stdinContent = await readStdin();
    if (!stdinContent.trim()) {
      debugLog("No stdin content received");
      process.exit(0);
    }

    const input: HookInput = JSON.parse(stdinContent);
    const eventName = input.hook_event_name;

    debugLog("Received event:", eventName);

    // Route to appropriate handler
    let output: HookOutput | void;

    switch (eventName) {
      case "SessionStart":
        output = await handleSessionStart(input as SessionStartInput);
        break;
      case "SessionEnd":
        await handleSessionEnd(input as SessionEndInput);
        break;
      case "UserPromptSubmit":
        output = await handleUserPromptSubmit(input as UserPromptSubmitInput);
        break;
      case "PreToolUse":
        await handlePreToolUse(input as PreToolUseInput);
        break;
      case "PostToolUse":
        await handlePostToolUse(input as PostToolUseInput);
        break;
      case "Stop":
        await handleStop(input as StopInput);
        break;
      case "SubagentStop":
        await handleSubagentStop(input as SubagentStopInput);
        break;
      case "Notification":
        await handleNotification(input as NotificationInput);
        break;
      case "PermissionRequest":
        await handlePermissionRequest(input as PermissionRequestInput);
        break;
      case "PreCompact":
        await handlePreCompact(input as PreCompactInput);
        break;
      default:
        debugLog("Unhandled event:", eventName);
    }

    // Output hook result if there is one
    if (output) {
      console.log(JSON.stringify(output));
    }

    // Success - exit cleanly
    process.exit(0);
  } catch (error) {
    // Log error but don't block Claude
    console.error("[claude-session-logger] Error:", error);
    process.exit(0); // Exit 0 to not block Claude
  }
}

main();
