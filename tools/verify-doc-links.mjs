#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function markdownFiles(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return markdownFiles(child);
    return entry.isFile() && entry.name.endsWith(".md") ? [child] : [];
  });
}

const files = ["AGENTS.md", "CLAUDE.md", ...markdownFiles("docs"), ...markdownFiles(".github/ISSUE_TEMPLATE")];
if (existsSync(".github/copilot-instructions.md")) files.push(".github/copilot-instructions.md");

const failures = [];
for (const file of files) {
  const content = readFileSync(file, "utf8");
  for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split("#", 1)[0];
    if (!target || target.startsWith("#") || target.includes("://") || target.startsWith("mailto:")) continue;
    const destination = resolve(dirname(file), target);
    if (!existsSync(destination)) failures.push(`${file}: missing ${target}`);
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Verified local Markdown links in ${files.length} files.`);
}
