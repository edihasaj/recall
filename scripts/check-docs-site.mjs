#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const docsDir = path.join(root, "docs");
const indexPath = path.join(docsDir, "index.html");
const cssPath = path.join(docsDir, "site.css");
const iconPath = path.join(docsDir, "icon.png");

const failures = [];

for (const file of [indexPath, cssPath, iconPath]) {
  if (!fs.existsSync(file)) failures.push(`missing ${path.relative(root, file)}`);
}

const html = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, "utf8") : "";
const required = [
  "Recall",
  "Recall remembers",
  "brew install --cask edihasaj/tap/recall",
  "recall setup --yes",
  "GitHub Releases",
  "CONTRIBUTING.md",
  "RELEASING.md",
];

for (const token of required) {
  if (!html.includes(token)) failures.push(`docs/index.html missing "${token}"`);
}

const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
for (const match of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
  const target = match[1];
  if (target.startsWith("http") || target.startsWith("mailto:")) continue;
  if (target.startsWith("#")) {
    const id = target.slice(1);
    if (id && !ids.has(id)) failures.push(`missing anchor #${id}`);
    continue;
  }
  if (target.startsWith("./")) {
    const targetPath = path.join(docsDir, target.slice(2));
    if (!fs.existsSync(targetPath)) failures.push(`missing local asset ${target}`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(`docs check: ${failure}`);
  process.exit(1);
}

console.log("docs site check passed");
