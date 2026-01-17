// Hook event types
export type HookEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "Stop"
  | "SubagentStop"
  | "Notification"
  | "PermissionRequest"
  | "PreCompact";

export type PermissionMode =
  | "default"
  | "plan"
  | "acceptEdits"
  | "dontAsk"
  | "bypassPermissions";

// Base hook input that all events receive
export interface BaseHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode: PermissionMode;
  hook_event_name: HookEventName;
}

// SessionStart specific input
export interface SessionStartInput extends BaseHookInput {
  hook_event_name: "SessionStart";
  source: "startup" | "resume" | "clear" | "compact";
  CLAUDE_ENV_FILE?: string;
}

// SessionEnd specific input
export interface SessionEndInput extends BaseHookInput {
  hook_event_name: "SessionEnd";
  reason: "clear" | "logout" | "prompt_input_exit" | "other";
}

// UserPromptSubmit specific input
export interface UserPromptSubmitInput extends BaseHookInput {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}

// Tool input for various tools
export interface BashToolInput {
  command: string;
  description?: string;
  timeout?: number;
  run_in_background?: boolean;
}

export interface WriteToolInput {
  file_path: string;
  content: string;
}

export interface EditToolInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface ReadToolInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

export interface GlobToolInput {
  pattern: string;
  path?: string;
}

export interface GrepToolInput {
  pattern: string;
  path?: string;
}

export interface WebFetchToolInput {
  url: string;
  prompt?: string;
}

export interface WebSearchToolInput {
  query: string;
}

export type ToolInput =
  | BashToolInput
  | WriteToolInput
  | EditToolInput
  | ReadToolInput
  | GlobToolInput
  | GrepToolInput
  | WebFetchToolInput
  | WebSearchToolInput
  | Record<string, unknown>;

// PreToolUse specific input
export interface PreToolUseInput extends BaseHookInput {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: ToolInput;
  tool_use_id: string;
}

// PostToolUse specific input
export interface PostToolUseInput extends BaseHookInput {
  hook_event_name: "PostToolUse";
  tool_name: string;
  tool_input: ToolInput;
  tool_use_id: string;
  tool_response: {
    filePath?: string;
    success?: boolean;
    exit_code?: number;
    [key: string]: unknown;
  };
}

// Stop specific input
export interface StopInput extends BaseHookInput {
  hook_event_name: "Stop";
  stop_hook_active: boolean;
}

// SubagentStop specific input
export interface SubagentStopInput extends BaseHookInput {
  hook_event_name: "SubagentStop";
  stop_hook_active: boolean;
}

// Notification specific input
export interface NotificationInput extends BaseHookInput {
  hook_event_name: "Notification";
  message: string;
  notification_type: "permission_prompt" | "idle_prompt" | "auth_success" | "elicitation_dialog";
}

// PermissionRequest specific input
export interface PermissionRequestInput extends BaseHookInput {
  hook_event_name: "PermissionRequest";
  tool_name: string;
  tool_input: ToolInput;
  tool_use_id: string;
}

// PreCompact specific input
export interface PreCompactInput extends BaseHookInput {
  hook_event_name: "PreCompact";
  trigger: "manual" | "auto";
  custom_instructions?: string;
}

// Union type of all hook inputs
export type HookInput =
  | SessionStartInput
  | SessionEndInput
  | UserPromptSubmitInput
  | PreToolUseInput
  | PostToolUseInput
  | StopInput
  | SubagentStopInput
  | NotificationInput
  | PermissionRequestInput
  | PreCompactInput
  | BaseHookInput;

// Transcript message types (from JSONL files)
export interface TranscriptMessage {
  uuid: string;
  type: "human" | "assistant" | "system";
  message: {
    role: "user" | "assistant" | "system";
    content: string | TranscriptContentBlock[];
  };
  timestamp?: string;
}

export interface TranscriptContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | unknown[];
}

// Database models
export interface SessionRecord {
  id: string;
  project_path: string;
  started_at: string;
  ended_at: string | null;
  status: "active" | "completed" | "interrupted";
  summary: string | null;
  message_count: number;
  interface: "cli" | "vscode" | "web";
  markdown_path: string | null;
}

export interface MessageRecord {
  id?: number;
  session_id: string;
  timestamp: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_name: string | null;
  tool_input: string | null;
  tool_output: string | null;
}

export interface ToolCallRecord {
  id?: number;
  session_id: string;
  message_id: number | null;
  timestamp: string;
  tool_name: string;
  input_summary: string | null;
  success: number | null;
  duration_ms: number | null;
}

// Configuration
export interface Config {
  logDir: string;
  dbPath: string;
  includeToolOutputs: boolean;
  maxToolOutputLength: number;
  enableWAL: boolean;
  excludeTools: string[];
  excludeProjects: string[];
  debug: boolean;
  // Retry and failure handling
  blockOnFailure: boolean;  // If true, exit non-zero on logging failure (blocks Claude)
  maxRetries: number;       // Number of automatic retries before giving up (default: 3)
  retryDelayMs: number;     // Delay between retries in milliseconds (default: 2000)
  // Performance
  maxSearchDays: number;    // Max days to search when looking for session files (default: 7)
}
