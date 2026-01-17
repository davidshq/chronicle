import { readFileSync, existsSync } from "fs";
import { debugLog } from "./config";
import type { TranscriptMessage, TranscriptContentBlock } from "./types";

export interface ParsedMessage {
  uuid: string;
  timestamp: string;
  role: "user" | "assistant" | "system";
  textContent: string;
  toolCalls: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>;
  toolResults: Array<{
    toolUseId: string;
    content: string;
  }>;
}

export function parseTranscript(transcriptPath: string): ParsedMessage[] {
  if (!existsSync(transcriptPath)) {
    debugLog("Transcript file not found:", transcriptPath);
    return [];
  }

  const messages: ParsedMessage[] = [];

  try {
    const content = readFileSync(transcriptPath, "utf-8");
    const lines = content.trim().split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);

        // Handle different transcript entry formats
        if (entry.type === "human" || entry.type === "assistant" || entry.type === "system") {
          const parsed = parseTranscriptEntry(entry);
          if (parsed) {
            messages.push(parsed);
          }
        } else if (entry.message) {
          // Alternative format
          const parsed = parseMessageFormat(entry);
          if (parsed) {
            messages.push(parsed);
          }
        }
      } catch (e) {
        // Skip malformed lines
        debugLog("Failed to parse transcript line:", e);
      }
    }
  } catch (e) {
    debugLog("Failed to read transcript file:", e);
  }

  return messages;
}

function parseTranscriptEntry(entry: TranscriptMessage): ParsedMessage | null {
  const { uuid, type, message, timestamp } = entry;

  if (!message?.content) {
    return null;
  }

  const role = type === "human" ? "user" : type === "assistant" ? "assistant" : "system";
  const textContent: string[] = [];
  const toolCalls: ParsedMessage["toolCalls"] = [];
  const toolResults: ParsedMessage["toolResults"] = [];

  if (typeof message.content === "string") {
    textContent.push(message.content);
  } else if (Array.isArray(message.content)) {
    for (const block of message.content as TranscriptContentBlock[]) {
      if (block.type === "text" && block.text) {
        textContent.push(block.text);
      } else if (block.type === "tool_use" && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          name: block.name,
          input: block.input || {},
        });
      } else if (block.type === "tool_result" && block.tool_use_id) {
        const content = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content);
        toolResults.push({
          toolUseId: block.tool_use_id,
          content,
        });
      }
    }
  }

  return {
    uuid,
    timestamp: timestamp || new Date().toISOString(),
    role,
    textContent: textContent.join("\n"),
    toolCalls,
    toolResults,
  };
}

interface AlternativeTranscriptEntry {
  uuid?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | Array<{
      type?: string;
      text?: string;
      id?: string;
      name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      content?: string | unknown[];
    }>;
  };
}

function parseMessageFormat(entry: AlternativeTranscriptEntry): ParsedMessage | null {
  const { message, uuid, timestamp } = entry;

  if (!message?.role || !message?.content) {
    return null;
  }

  const role = message.role as "user" | "assistant" | "system";
  const textContent: string[] = [];
  const toolCalls: ParsedMessage["toolCalls"] = [];
  const toolResults: ParsedMessage["toolResults"] = [];

  if (typeof message.content === "string") {
    textContent.push(message.content);
  } else if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === "text" && block.text) {
        textContent.push(block.text);
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id || "",
          name: block.name || "",
          input: block.input || {},
        });
      } else if (block.type === "tool_result") {
        const content = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content);
        toolResults.push({
          toolUseId: block.tool_use_id || "",
          content,
        });
      }
    }
  }

  return {
    uuid: uuid || `msg-${Date.now()}`,
    timestamp: timestamp || new Date().toISOString(),
    role,
    textContent: textContent.join("\n"),
    toolCalls,
    toolResults,
  };
}

// Extract assistant's text response from the latest messages
export function getLatestAssistantResponse(transcriptPath: string): string | null {
  const messages = parseTranscript(transcriptPath);

  // Find the last assistant message with text content
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && msg.textContent.trim()) {
      return msg.textContent;
    }
  }

  return null;
}
