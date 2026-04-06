/**
 * Generate TypeDoc API reference and fix paths for VitePress.
 *
 * pkgroll produces dist/index.d.mts, dist/redis/index.d.mts, etc.
 * TypeDoc creates module dirs from the dist file names which are ugly.
 * This script renames them to clean names and fixes all internal links.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const API_DIR = join(import.meta.dirname, "..", "api");

// ── Step 1: Run TypeDoc ───────────────────────────────────────────
console.log("Running TypeDoc...");
execSync("bunx typedoc", { cwd: join(import.meta.dirname, ".."), stdio: "inherit" });

// ── Step 2: Rename module dirs ────────────────────────────────────
// TypeDoc creates dirs like "index.d" (from index.d.mts), "index.d-1", etc.
// Rename them to clean names: taskora, redis, memory, test

const MODULE_RENAME: Record<string, string> = {};

// Discover what TypeDoc generated
if (existsSync(API_DIR)) {
  const dirs = readdirSync(API_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  // TypeDoc with "resolve" strategy creates dirs based on module filenames.
  // For our 4 entry points it typically creates: index.d, index.d-1, index.d-2, index.d-3
  // We need to figure out which is which by checking contents
  for (const dir of dirs) {
    const dirPath = join(API_DIR, dir);
    const indexFile = join(dirPath, "index.md");
    if (!existsSync(indexFile)) continue;

    const content = readFileSync(indexFile, "utf-8");

    if (content.includes("redisAdapter") || content.includes("RedisBackend")) {
      MODULE_RENAME[dir] = "redis";
    } else if (content.includes("memoryAdapter") || content.includes("MemoryBackend")) {
      MODULE_RENAME[dir] = "memory";
    } else if (content.includes("createTestRunner") || content.includes("TestRunner")) {
      MODULE_RENAME[dir] = "test";
    } else if (content.includes("taskora") || content.includes("App")) {
      MODULE_RENAME[dir] = "taskora";
    }
  }

  // Perform renames
  for (const [oldName, newName] of Object.entries(MODULE_RENAME)) {
    if (oldName === newName) continue;
    const oldPath = join(API_DIR, oldName);
    const newPath = join(API_DIR, newName);
    if (existsSync(newPath)) rmSync(newPath, { recursive: true });
    renameSync(oldPath, newPath);
    console.log(`  Renamed: ${oldName} → ${newName}`);
  }
}

// ── Step 3: Fix links in all .md files ────────────────────────────
function fixLinks(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Remove dirs with brackets — VitePress treats them as dynamic routes
      if (entry.name.includes("[") || entry.name.includes("]")) {
        rmSync(fullPath, { recursive: true });
        continue;
      }
      fixLinks(fullPath);
    } else if (entry.name.endsWith(".md")) {
      let content = readFileSync(fullPath, "utf-8");

      // Replace old module dir names in links
      for (const [oldName, newName] of Object.entries(MODULE_RENAME)) {
        if (oldName === newName) continue;
        content = content.replaceAll(`/${oldName}/`, `/${newName}/`);
        content = content.replaceAll(`(${oldName}/`, `(${newName}/`);
      }

      // Remove .md extensions from links (VitePress cleanUrls)
      content = content.replace(/\]\(([^)]+)\.md\)/g, "]($1)");
      content = content.replace(/\]\(([^)]+)\.md#/g, "]($1#");

      writeFileSync(fullPath, content);
    }
  }
}

if (existsSync(API_DIR)) {
  fixLinks(API_DIR);
}

// ── Step 4: Fix sidebar JSON ──────────────────────────────────────
const sidebarPath = join(API_DIR, "typedoc-sidebar.json");
if (existsSync(sidebarPath)) {
  let sidebar = readFileSync(sidebarPath, "utf-8");

  for (const [oldName, newName] of Object.entries(MODULE_RENAME)) {
    if (oldName === newName) continue;
    sidebar = sidebar.replaceAll(`/${oldName}/`, `/${newName}/`);
  }

  // Remove .md extensions
  sidebar = sidebar.replace(/\.md"/g, '"');
  sidebar = sidebar.replace(/\.md#/g, "#");

  writeFileSync(sidebarPath, sidebar);
  console.log("  Fixed sidebar links");
}

// ── Step 5: Write landing page ────────────────────────────────────
const landingPage = `---
title: Taskora API Reference
description: Auto-generated TypeScript API reference for all taskora entrypoints.
---

# API Reference

Auto-generated from TypeScript declarations. Browse classes, interfaces, types, and methods.

## Entrypoints

| Package | Description |
|---------|-------------|
| [taskora](/api/taskora/) | Core — App, Task, ResultHandle, Inspector, types, errors |
| [taskora/redis](/api/redis/) | Redis adapter factory |
| [taskora/memory](/api/memory/) | In-memory adapter factory |
| [taskora/test](/api/test/) | Test runner utilities |
`;

writeFileSync(join(API_DIR, "index.md"), landingPage);
console.log("Done!");
