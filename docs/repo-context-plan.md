# Repo Context Plan
read_when: working on repo-local Recall context artifacts for Codex, Claude, or other agents

## Goal

Publish Recall memory into a repo-local file so agents can read it from the filesystem without relying on startup hooks or wrappers.

## Artifact

- path: `.recall/context.md`
- owner: Recall
- source: compiled active memories for the repo

## Flow

1. Recall learns through daemon/MCP/session events.
2. Recall writes `.recall/context.md` in the repo root.
3. `AGENTS.md` or `CLAUDE.md` can point agents to that file.
4. Agents read the file before making repo-specific assumptions.

## Why

- deterministic
- portable across tools
- no per-session MCP call required for basic repo context
- easier to explain than wrappers

## Write Triggers

- session start
- repo scan
- explicit publish command
- future: correction/review when repo path is known

## Non-Goals

- full transcript capture
- passive process spying
- replacing MCP for explicit query/report actions
