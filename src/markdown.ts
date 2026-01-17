import { existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { getConfig, getDateDir, getSessionsDir, debugLog } from "./config";
import { getSessionMarkdownPath, updateSessionMarkdownPath } from "./db";
import type { ToolInput, BashToolInput, WriteToolInput, EditToolInput, ReadToolInput, GlobToolInput, GrepToolInput, WebFetchToolInput, WebSearchToolInput } from "./types";

// Get the sessions directory, optionally using a custom base log directory
function getEffectiveSessionsDir(customLogDir?: string | null): string {
  if (customLogDir) {
    const sessionsDir = join(customLogDir, "sessions");
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }
    return sessionsDir;
  }
  return getSessionsDir();
}

// Get the date directory, optionally using a custom base log directory
function getEffectiveDateDir(date: Date = new Date(), customLogDir?: string | null): string {
  if (customLogDir) {
    const dateStr = date.toLocaleDateString("en-CA"); // YYYY-MM-DD in local timezone
    const dir = join(customLogDir, "sessions", dateStr);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }
  return getDateDir(date);
}

interface MarkdownSession {
  filePath: string;
  sessionId: string;
  projectPath: string;
  startedAt: string;
}

// Cache of active markdown files by session ID
const activeSessions = new Map<string, MarkdownSession>();

function sanitizeFilename(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);
}

function getProjectName(projectPath: string): string {
  return sanitizeFilename(basename(projectPath)) || "unknown-project";
}

function formatTimeForFilename(date: Date): string {
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const seconds = date.getSeconds().toString().padStart(2, "0");
  return `${hours}${minutes}${seconds}`;
}

function getNextSequenceNumber(dateDir: string): string {
  if (!existsSync(dateDir)) {
    return "01";
  }

  const files = readdirSync(dateDir).filter((f) => f.endsWith(".md"));
  if (files.length === 0) {
    return "01";
  }

  // Extract sequence numbers from existing files (format: NN_HHMMSS_sessionid_project.md)
  const sequences = files
    .map((f) => {
      const match = f.match(/^(\d+)_/);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter((n) => !isNaN(n));

  const maxSequence = sequences.length > 0 ? Math.max(...sequences) : 0;
  return (maxSequence + 1).toString().padStart(2, "0");
}

export function generateMarkdownPath(sessionId: string, projectPath: string, startDate: Date = new Date(), customLogDir?: string | null): string {
  const dateDir = getEffectiveDateDir(startDate, customLogDir);
  const projectName = getProjectName(projectPath);
  const shortSessionId = sessionId.substring(0, 8);
  const timeStr = formatTimeForFilename(startDate);
  const sequence = getNextSequenceNumber(dateDir);
  return join(dateDir, `${sequence}_${timeStr}_${shortSessionId}_${projectName}.md`);
}

export function initMarkdownFile(sessionId: string, projectPath: string, startedAt: string, source: string, customLogDir?: string | null, customDbPath?: string | null): string {
  const startDate = new Date(startedAt);

  // First check if we already have an active session in memory
  const existingActive = activeSessions.get(sessionId);
  if (existingActive && existsSync(existingActive.filePath)) {
    debugLog("Resuming from in-memory cache:", existingActive.filePath);
    const resumeMarker = `\n---\n\n## Session Resumed\n**Time**: ${new Date().toISOString()}\n**Source**: ${source}\n\n---\n\n`;
    appendFileSync(existingActive.filePath, resumeMarker);
    return existingActive.filePath;
  }

  // Check database for existing path (use custom DB if configured)
  const dbPath = getSessionMarkdownPath(sessionId, customDbPath);
  if (dbPath && existsSync(dbPath)) {
    debugLog("Resuming from database path:", dbPath);
    activeSessions.set(sessionId, { filePath: dbPath, sessionId, projectPath, startedAt });
    const resumeMarker = `\n---\n\n## Session Resumed\n**Time**: ${new Date().toISOString()}\n**Source**: ${source}\n\n---\n\n`;
    appendFileSync(dbPath, resumeMarker);
    return dbPath;
  }

  // Search for existing file by session ID in filename (use custom log dir if configured)
  const existingFile = searchForSessionFile(sessionId, customLogDir);
  if (existingFile) {
    debugLog("Found existing file by search:", existingFile);
    activeSessions.set(sessionId, { filePath: existingFile, sessionId, projectPath, startedAt });
    updateSessionMarkdownPath(sessionId, existingFile, customDbPath);
    const resumeMarker = `\n---\n\n## Session Resumed\n**Time**: ${new Date().toISOString()}\n**Source**: ${source}\n\n---\n\n`;
    appendFileSync(existingFile, resumeMarker);
    return existingFile;
  }

  // Create new file with sequence number
  const filePath = generateMarkdownPath(sessionId, projectPath, startDate, customLogDir);

  const header = `# Session: ${sessionId}

**Project**: \`${projectPath}\`
**Started**: ${startedAt}
**Status**: Active

---

`;

  writeFileSync(filePath, header);
  activeSessions.set(sessionId, { filePath, sessionId, projectPath, startedAt });
  updateSessionMarkdownPath(sessionId, filePath, customDbPath);
  debugLog("Created markdown file:", filePath);

  return filePath;
}

export function getActiveMarkdownPath(sessionId: string): string | null {
  const session = activeSessions.get(sessionId);
  return session?.filePath || null;
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function truncateContent(content: string, maxLength: number): string {
  if (content.length <= maxLength) {
    return content;
  }
  return content.substring(0, maxLength) + "\n\n... (truncated)";
}

function formatToolInput(toolName: string, input: ToolInput): string {
  const config = getConfig();

  switch (toolName) {
    case "Bash": {
      const bashInput = input as BashToolInput;
      let result = `**Command**: \`${bashInput.command}\``;
      if (bashInput.description) {
        result += `\n**Description**: ${bashInput.description}`;
      }
      return result;
    }
    case "Write": {
      const writeInput = input as WriteToolInput;
      const content = truncateContent(writeInput.content, config.maxToolOutputLength);
      return `**File**: \`${writeInput.file_path}\`\n\n\`\`\`\n${content}\n\`\`\``;
    }
    case "Edit": {
      const editInput = input as EditToolInput;
      const oldStr = truncateContent(editInput.old_string, config.maxToolOutputLength / 2);
      const newStr = truncateContent(editInput.new_string, config.maxToolOutputLength / 2);
      return `**File**: \`${editInput.file_path}\`\n\n**Replace**:\n\`\`\`\n${oldStr}\n\`\`\`\n\n**With**:\n\`\`\`\n${newStr}\n\`\`\``;
    }
    case "Read": {
      const readInput = input as ReadToolInput;
      return `**File**: \`${readInput.file_path}\``;
    }
    case "Glob": {
      const globInput = input as GlobToolInput;
      return `**Pattern**: \`${globInput.pattern}\``;
    }
    case "Grep": {
      const grepInput = input as GrepToolInput;
      return `**Pattern**: \`${grepInput.pattern}\`\n**Path**: \`${grepInput.path || "."}\``;
    }
    case "WebFetch": {
      const fetchInput = input as WebFetchToolInput;
      return `**URL**: ${fetchInput.url}`;
    }
    case "WebSearch": {
      const searchInput = input as WebSearchToolInput;
      return `**Query**: ${searchInput.query}`;
    }
    default:
      // Generic formatting for unknown tools
      const jsonStr = JSON.stringify(input, null, 2);
      return `\`\`\`json\n${truncateContent(jsonStr, config.maxToolOutputLength)}\n\`\`\``;
  }
}

export function appendUserMessage(sessionId: string, timestamp: string, content: string): void {
  const filePath = getActiveMarkdownPath(sessionId);
  if (!filePath) {
    debugLog("No active markdown file for session:", sessionId);
    return;
  }

  const time = formatTimestamp(timestamp);
  const entry = `## User (${time})\n\n${content}\n\n---\n\n`;

  appendFileSync(filePath, entry);
  debugLog("Appended user message to markdown");
}

export function appendToolCall(
  sessionId: string,
  timestamp: string,
  toolName: string,
  toolInput: ToolInput
): void {
  const filePath = getActiveMarkdownPath(sessionId);
  if (!filePath) {
    debugLog("No active markdown file for session:", sessionId);
    return;
  }

  const time = formatTimestamp(timestamp);
  const formattedInput = formatToolInput(toolName, toolInput);
  const entry = `### Tool: ${toolName} (${time})\n\n${formattedInput}\n\n`;

  appendFileSync(filePath, entry);
  debugLog("Appended tool call to markdown:", toolName);
}

export function appendToolResult(
  sessionId: string,
  _toolName: string,
  success: boolean,
  output?: string
): void {
  const filePath = getActiveMarkdownPath(sessionId);
  if (!filePath) {
    return;
  }

  const config = getConfig();
  const statusEmoji = success ? "✓" : "✗";
  let entry = `**Result**: ${statusEmoji} ${success ? "Success" : "Failed"}\n\n`;

  if (config.includeToolOutputs && output) {
    const truncatedOutput = truncateContent(output, config.maxToolOutputLength);
    entry += `<details>\n<summary>Output</summary>\n\n\`\`\`\n${truncatedOutput}\n\`\`\`\n</details>\n\n`;
  }

  appendFileSync(filePath, entry);
}

export function appendAssistantMessage(sessionId: string, timestamp: string, content: string): void {
  const filePath = getActiveMarkdownPath(sessionId);
  if (!filePath) {
    debugLog("No active markdown file for session:", sessionId);
    return;
  }

  const time = formatTimestamp(timestamp);
  const entry = `## Assistant (${time})\n\n${content}\n\n---\n\n`;

  appendFileSync(filePath, entry);
  debugLog("Appended assistant message to markdown");
}

export function finalizeMarkdownFile(sessionId: string, status: string, projectPath?: string): void {
  let filePath = getActiveMarkdownPath(sessionId);

  // Try to find the file if not in active sessions (cross-process scenario)
  if (!filePath && projectPath) {
    filePath = findExistingMarkdownFile(sessionId, projectPath);
  }

  if (!filePath) {
    debugLog("No markdown file found to finalize for session:", sessionId);
    return;
  }

  // Read current content and update status
  try {
    let content = readFileSync(filePath, "utf-8");
    content = content.replace("**Status**: Active", `**Status**: ${status}`);

    // Add end marker
    const endMarker = `\n---\n\n## Session Ended\n**Time**: ${new Date().toISOString()}\n**Status**: ${status}\n`;
    content += endMarker;

    writeFileSync(filePath, content);
    activeSessions.delete(sessionId);
    debugLog("Finalized markdown file:", filePath);
  } catch (e) {
    debugLog("Error finalizing markdown:", e);
  }
}

// Search for existing file by session ID in filename (checks recent date directories)
function searchForSessionFile(sessionId: string, customLogDir?: string | null, maxSearchDays?: number): string | null {
  const shortSessionId = sessionId.substring(0, 8);
  const sessionsDir = getEffectiveSessionsDir(customLogDir);
  const config = getConfig();
  const searchDays = maxSearchDays ?? config.maxSearchDays;

  if (!existsSync(sessionsDir)) return null;

  // Check recent date directories (handles timezone transitions and multi-day sessions)
  // Limited to maxSearchDays to avoid scanning years of logs
  const dateDirs = readdirSync(sessionsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse() // Most recent first
    .slice(0, searchDays); // Limit to configured days

  for (const dirName of dateDirs) {
    const dateDir = join(sessionsDir, dirName);
    const files = readdirSync(dateDir);
    for (const file of files) {
      // Match files containing the session ID (format: NN_HHMMSS_sessionid_project.md)
      if (file.includes(shortSessionId) && file.endsWith(".md")) {
        return join(dateDir, file);
      }
    }
  }

  return null;
}

// For resuming sessions - try to find existing markdown file
export function findExistingMarkdownFile(sessionId: string, projectPath: string, customLogDir?: string | null, customDbPath?: string | null): string | null {
  // First check database (use custom DB if configured)
  const dbPath = getSessionMarkdownPath(sessionId, customDbPath);
  if (dbPath && existsSync(dbPath)) {
    activeSessions.set(sessionId, {
      filePath: dbPath,
      sessionId,
      projectPath,
      startedAt: new Date().toISOString(),
    });
    return dbPath;
  }

  // Search by session ID in filename (use custom log dir if configured)
  const foundPath = searchForSessionFile(sessionId, customLogDir);
  if (foundPath) {
    activeSessions.set(sessionId, {
      filePath: foundPath,
      sessionId,
      projectPath,
      startedAt: new Date().toISOString(),
    });
    updateSessionMarkdownPath(sessionId, foundPath, customDbPath);
    return foundPath;
  }

  return null;
}

export function appendNotification(
  sessionId: string,
  timestamp: string,
  notificationType: string,
  message: string
): void {
  const filePath = getActiveMarkdownPath(sessionId);
  if (!filePath) {
    return;
  }

  const time = formatTimestamp(timestamp);
  const typeLabel = notificationType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const entry = `### 🔔 Notification: ${typeLabel} (${time})\n\n${message}\n\n`;

  appendFileSync(filePath, entry);
  debugLog("Appended notification to markdown:", notificationType);
}

export function appendPermissionRequest(
  sessionId: string,
  timestamp: string,
  toolName: string,
  inputSummary: string
): void {
  const filePath = getActiveMarkdownPath(sessionId);
  if (!filePath) {
    return;
  }

  const time = formatTimestamp(timestamp);
  const entry = `### 🔐 Permission Request (${time})\n\n**Tool**: ${toolName}\n**Input**: ${inputSummary}\n\n`;

  appendFileSync(filePath, entry);
  debugLog("Appended permission request to markdown:", toolName);
}

export function appendPreCompact(
  sessionId: string,
  timestamp: string,
  trigger: string,
  backupPath?: string
): void {
  const filePath = getActiveMarkdownPath(sessionId);
  if (!filePath) {
    return;
  }

  const time = formatTimestamp(timestamp);
  let entry = `### 📦 Context Compaction (${time})\n\n**Trigger**: ${trigger}\n`;
  if (backupPath) {
    entry += `**Backup**: \`${backupPath}\`\n`;
  }
  entry += "\n";

  appendFileSync(filePath, entry);
  debugLog("Appended pre-compact to markdown");
}

export function appendSubagentStop(
  sessionId: string,
  timestamp: string,
  description?: string
): void {
  const filePath = getActiveMarkdownPath(sessionId);
  if (!filePath) {
    return;
  }

  const time = formatTimestamp(timestamp);
  let entry = `### 🤖 Subagent Completed (${time})\n\n`;
  if (description) {
    entry += `${description}\n\n`;
  }

  appendFileSync(filePath, entry);
  debugLog("Appended subagent stop to markdown");
}
