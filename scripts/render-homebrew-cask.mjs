#!/usr/bin/env node
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const version = stripV(process.env.RECALL_RELEASE_TAG) || process.env.RECALL_VERSION || pkg.version;
const sha256 = process.env.RECALL_APP_ZIP_SHA256 || "REPLACE_WITH_RELEASE_SHA256";
const repo = process.env.RECALL_GITHUB_REPO || "edihasaj/recall";
const homepage = process.env.RECALL_HOMEPAGE || pkg.homepage || "https://recallmemory.dev/";
const template = readFileSync(
  new URL("../packaging/homebrew/Casks/recall.rb.template", import.meta.url),
  "utf8",
);

const rendered = template
  .replace(/version "[^"]+"/, () => `version "${rubyString(version)}"`)
  .replace(/sha256 "[^"]+"/, () => `sha256 "${rubyString(sha256)}"`)
  .replace("github.com/edihasaj/recall", `github.com/${repo}`)
  .replace(/homepage "[^"]+"/, () => `homepage "${rubyString(homepage)}"`);

process.stdout.write(rendered.endsWith("\n") ? rendered : `${rendered}\n`);

function stripV(tag) {
  if (!tag) return "";
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

function rubyString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
