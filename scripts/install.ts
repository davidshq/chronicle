#!/usr/bin/env bun
/**
 * Installation script for claude-remember plugin
 *
 * This script installs the plugin by:
 * 1. Creating a symlink in ~/.claude/plugins/
 * 2. Enabling the plugin in settings.json
 * 3. Removing any legacy hooks from previous installation method
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, unlinkSync, lstatSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

const CLAUDE_DIR = join(homedir(), ".claude");
const CLAUDE_PLUGINS_DIR = join(CLAUDE_DIR, "plugins");
const CLAUDE_SETTINGS_FILE = join(CLAUDE_DIR, "settings.json");
const PLUGIN_NAME = "claude-remember";

// Get the absolute path to the plugin root
const PLUGIN_DIR = resolve(join(import.meta.dir, ".."));
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
  if (!existsSync(CLAUDE_DIR)) {
    mkdirSync(CLAUDE_DIR, { recursive: true });
  }
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

function install(): void {
  console.log("Installing claude-remember plugin...\n");
  console.log(`Plugin directory: ${PLUGIN_DIR}`);

  // Verify plugin manifest exists
  const manifestPath = join(PLUGIN_DIR, ".claude-plugin", "plugin.json");
  if (!existsSync(manifestPath)) {
    console.error(`Error: Plugin manifest not found at ${manifestPath}`);
    process.exit(1);
  }

  // Create plugins directory if needed
  if (!existsSync(CLAUDE_PLUGINS_DIR)) {
    mkdirSync(CLAUDE_PLUGINS_DIR, { recursive: true });
    console.log(`  ✓ Created plugins directory: ${CLAUDE_PLUGINS_DIR}`);
  }

  // Create or update symlink
  if (existsSync(PLUGIN_LINK)) {
    const stats = lstatSync(PLUGIN_LINK);
    if (stats.isSymbolicLink()) {
      unlinkSync(PLUGIN_LINK);
      console.log(`  ✓ Removed existing symlink`);
    } else {
      console.error(`Error: ${PLUGIN_LINK} exists but is not a symlink. Please remove it manually.`);
      process.exit(1);
    }
  }

  symlinkSync(PLUGIN_DIR, PLUGIN_LINK);
  console.log(`  ✓ Created symlink: ${PLUGIN_LINK} -> ${PLUGIN_DIR}`);

  // Load and update settings
  const settings = loadSettings();

  // Remove legacy hooks
  const removedHooks = removeLegacyHooks(settings);
  if (removedHooks > 0) {
    console.log(`  ✓ Removed ${removedHooks} legacy hooks from settings.json`);
  }

  // Remove old @local reference if present
  const enabledPlugins = (settings.enabledPlugins as Record<string, boolean>) || {};
  const oldPluginKey = `${PLUGIN_NAME}@local`;
  if (enabledPlugins[oldPluginKey]) {
    delete enabledPlugins[oldPluginKey];
    console.log(`  ✓ Removed old plugin reference: ${oldPluginKey}`);
  }

  // Register plugin directory as a known marketplace
  const extraMarketplaces = (settings.extraKnownMarketplaces as string[]) || [];
  if (!extraMarketplaces.includes(PLUGIN_DIR)) {
    extraMarketplaces.push(PLUGIN_DIR);
    settings.extraKnownMarketplaces = extraMarketplaces;
    console.log(`  ✓ Registered as marketplace: ${PLUGIN_DIR}`);
  }

  // Enable the plugin using the marketplace reference format
  const pluginKey = `${PLUGIN_NAME}@${PLUGIN_DIR}`;

  if (!enabledPlugins[pluginKey]) {
    enabledPlugins[pluginKey] = true;
    settings.enabledPlugins = enabledPlugins;
    console.log(`  ✓ Enabled plugin: ${pluginKey}`);
  } else {
    console.log(`  ⚠ Plugin already enabled: ${pluginKey}`);
  }

  // Save updated settings
  saveSettings(settings);

  console.log("\n✅ Installation complete!");
  console.log("\nThe plugin provides:");
  console.log("  - Automatic session logging to ~/.claude-logs/");
  console.log("  - /claude-remember:status  - View logging status");
  console.log("  - /claude-remember:search  - Search past sessions");
  console.log("  - /claude-remember:today   - View today's sessions");
  console.log("\nTo customize, create ~/.claude-logs/config.json");
  console.log("\nNOTE: You may need to restart Claude Code for changes to take effect.");
}

install();
