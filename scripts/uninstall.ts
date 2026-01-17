#!/usr/bin/env bun
/**
 * Uninstallation script for claude-remember plugin
 *
 * This script uninstalls the plugin by:
 * 1. Removing the symlink from ~/.claude/plugins/
 * 2. Disabling the plugin in settings.json
 * 3. Removing any legacy hooks (from previous installation method)
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, lstatSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const CLAUDE_DIR = join(homedir(), ".claude");
const CLAUDE_PLUGINS_DIR = join(CLAUDE_DIR, "plugins");
const CLAUDE_SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");
const PLUGIN_NAME = "claude-remember";
const PLUGIN_LINK = join(CLAUDE_PLUGINS_DIR, PLUGIN_NAME);

// Legacy hook events to clean up
const LEGACY_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "Notification",
  "PermissionRequest",
  "PreCompact",
];

function loadSettings(): Record<string, unknown> {
  if (!existsSync(CLAUDE_SETTINGS_FILE)) {
    return {};
  }

  try {
    const content = readFileSync(CLAUDE_SETTINGS_FILE, "utf-8");
    return JSON.parse(content);
  } catch (e) {
    console.error("Failed to parse existing settings:", e);
    return {};
  }
}

function saveSettings(settings: Record<string, unknown>): void {
  writeFileSync(CLAUDE_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function removeLegacyHooks(settings: Record<string, unknown>): number {
  const hooks = (settings.hooks as Record<string, unknown[]>) || {};
  let removedCount = 0;

  for (const eventName of LEGACY_HOOK_EVENTS) {
    if (!hooks[eventName]) {
      continue;
    }

    const eventHooks = hooks[eventName] as any[];
    const filtered = eventHooks.filter((h) => {
      const isOurs = h.hooks?.some((hook: any) =>
        hook.command?.includes("claude-remember") ||
        hook.command?.includes("session-logger") ||
        hook.command?.includes("handler.ts")
      );
      return !isOurs;
    });

    if (filtered.length !== eventHooks.length) {
      removedCount++;
      if (filtered.length === 0) {
        delete hooks[eventName];
      } else {
        hooks[eventName] = filtered;
      }
    }
  }

  // Clean up empty hooks object
  if (Object.keys(hooks).length === 0) {
    delete settings.hooks;
  } else {
    settings.hooks = hooks;
  }

  return removedCount;
}

function uninstall(): void {
  console.log("Uninstalling claude-remember plugin...\n");

  let changes = 0;

  // Remove symlink
  if (existsSync(PLUGIN_LINK)) {
    const stats = lstatSync(PLUGIN_LINK);
    if (stats.isSymbolicLink()) {
      unlinkSync(PLUGIN_LINK);
      console.log(`  ✓ Removed symlink: ${PLUGIN_LINK}`);
      changes++;
    } else {
      console.log(`  ⚠ ${PLUGIN_LINK} is not a symlink, skipping`);
    }
  } else {
    console.log(`  - Symlink not found: ${PLUGIN_LINK}`);
  }

  // Load and update settings
  const settings = loadSettings();

  // Disable the plugin (check both old @local format and new @path format)
  const enabledPlugins = (settings.enabledPlugins as Record<string, boolean>) || {};

  // Remove old @local reference
  const oldPluginKey = `${PLUGIN_NAME}@local`;
  if (enabledPlugins[oldPluginKey]) {
    delete enabledPlugins[oldPluginKey];
    console.log(`  ✓ Disabled plugin: ${oldPluginKey}`);
    changes++;
  }

  // Remove new @path reference (check all keys that start with plugin name)
  for (const key of Object.keys(enabledPlugins)) {
    if (key.startsWith(`${PLUGIN_NAME}@`)) {
      delete enabledPlugins[key];
      console.log(`  ✓ Disabled plugin: ${key}`);
      changes++;
    }
  }

  if (Object.keys(enabledPlugins).length === 0) {
    delete settings.enabledPlugins;
  } else {
    settings.enabledPlugins = enabledPlugins;
  }

  // Remove from extraKnownMarketplaces
  const extraMarketplaces = (settings.extraKnownMarketplaces as string[]) || [];
  const marketplaceIndex = extraMarketplaces.findIndex(m => m.includes(PLUGIN_NAME) || m.includes("claude-remember"));
  if (marketplaceIndex !== -1) {
    const removed = extraMarketplaces.splice(marketplaceIndex, 1)[0];
    if (extraMarketplaces.length === 0) {
      delete settings.extraKnownMarketplaces;
    } else {
      settings.extraKnownMarketplaces = extraMarketplaces;
    }
    console.log(`  ✓ Removed marketplace: ${removed}`);
    changes++;
  }

  // Remove legacy hooks
  const removedHooks = removeLegacyHooks(settings);
  if (removedHooks > 0) {
    console.log(`  ✓ Removed ${removedHooks} legacy hooks`);
    changes++;
  }

  if (changes > 0) {
    saveSettings(settings);
    console.log("\n✅ Uninstallation complete!");
  } else {
    console.log("\nNo claude-remember installation found.");
  }

  console.log("\nNote: Your log files at ~/.claude-logs/ have been preserved.");
  console.log("Delete them manually if you no longer need them:");
  console.log("  rm -rf ~/.claude-logs/");
}

uninstall();
