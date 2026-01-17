#!/usr/bin/env bun
/**
 * Bump the plugin version
 *
 * Usage:
 *   bun run scripts/bump-version.ts        # patch bump (0.3.1 -> 0.3.2)
 *   bun run scripts/bump-version.ts minor  # minor bump (0.3.1 -> 0.4.0)
 *   bun run scripts/bump-version.ts major  # major bump (0.3.1 -> 1.0.0)
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const PLUGIN_JSON_PATH = join(import.meta.dir, "../.claude-plugin/plugin.json");
const PACKAGE_JSON_PATH = join(import.meta.dir, "../package.json");

type BumpType = "patch" | "minor" | "major";

function bumpVersion(version: string, type: BumpType): string {
  const [major, minor, patch] = version.split(".").map(Number);

  switch (type) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
    default:
      return `${major}.${minor}.${patch + 1}`;
  }
}

function main() {
  const bumpType = (process.argv[2] as BumpType) || "patch";

  if (!["patch", "minor", "major"].includes(bumpType)) {
    console.error("Usage: bun run scripts/bump-version.ts [patch|minor|major]");
    process.exit(1);
  }

  // Read current plugin.json
  const pluginContent = readFileSync(PLUGIN_JSON_PATH, "utf-8");
  const plugin = JSON.parse(pluginContent);

  const oldVersion = plugin.version;
  const newVersion = bumpVersion(oldVersion, bumpType);

  // Update plugin.json
  plugin.version = newVersion;
  writeFileSync(PLUGIN_JSON_PATH, JSON.stringify(plugin, null, 2) + "\n");

  // Update package.json to keep in sync
  const packageContent = readFileSync(PACKAGE_JSON_PATH, "utf-8");
  const pkg = JSON.parse(packageContent);
  pkg.version = newVersion;
  writeFileSync(PACKAGE_JSON_PATH, JSON.stringify(pkg, null, 2) + "\n");

  console.log(`Bumped version: ${oldVersion} -> ${newVersion}`);
  console.log(`\nNext steps:`);
  console.log(`  git add .claude-plugin/plugin.json package.json`);
  console.log(`  git commit -m "Release v${newVersion}"`);
  console.log(`  git push origin main`);
}

main();
