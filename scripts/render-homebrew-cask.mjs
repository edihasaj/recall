#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const version = stripV(process.env.RECALL_RELEASE_TAG) || process.env.RECALL_VERSION || pkg.version;
const tag = process.env.RECALL_RELEASE_TAG || `v${version}`;
const sha256 = process.env.RECALL_APP_ZIP_SHA256 || "REPLACE_WITH_RELEASE_SHA256";
const repo = process.env.RECALL_GITHUB_REPO || "edihasaj/recall";
const homepage = process.env.RECALL_HOMEPAGE || pkg.homepage || "https://edihasaj.github.io/recall/";

console.log(`cask "recall" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/${repo}/releases/download/${tag}/Recall.app.zip"
  name "Recall"
  desc "Local repo-memory compiler for coding agents"
  homepage "${homepage}"

  depends_on macos: ">= :sequoia"

  app "Recall.app"

  zap trash: [
    "~/.recall",
    "~/Library/LaunchAgents/com.recall.daemon.plist",
    "~/Library/Preferences/com.edihasaj.recall.plist",
  ]
end`);

function stripV(tag) {
  if (!tag) return "";
  return tag.startsWith("v") ? tag.slice(1) : tag;
}
