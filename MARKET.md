# Recall Market Notes

Date: 2026-04-11

## Existing Products / Projects

### MCP Memory Keeper

- Repo: https://github.com/mkreyman/mcp-memory-keeper
- Positioning: persistent context for Claude coding sessions
- What it emphasizes:
  - persistent context across sessions
  - Claude-oriented workflow
  - explicit session save/restore patterns
- Threat to Recall:
  - very close if users mainly want "don’t lose session context"

### Redis Agent Memory Server

- Repo: https://github.com/redis/agent-memory-server
- Positioning: general memory layer for agents
- What it emphasizes:
  - MCP + REST
  - working memory + long-term memory
  - search / retrieval / backend flexibility
- Threat to Recall:
  - broader platform story
  - stronger if buyer wants general agent infra, not coding memory specifically

### Julep Memory Store Plugin

- Repo: https://github.com/julep-ai/memory-store-plugin
- Positioning: automatic development tracking for Claude Code
- What it emphasizes:
  - automatic tracking
  - session/file/commit/error capture
  - context loading back into future sessions
- Threat to Recall:
  - strong if users want automatic tracking with minimal manual flow

### Claude Mem

- Repo: https://github.com/thedotmack/claude-mem
- Positioning: capture everything Claude does, compress it, inject relevant context later
- What it emphasizes:
  - automatic session capture
  - future reinjection
  - multi-tool/plugin surface
- Threat to Recall:
  - very close on "memory for coding sessions"

### MCP Local RAG

- Repo: https://github.com/shinpr/mcp-local-rag
- Positioning: local-first retrieval for code/docs via MCP or CLI
- What it emphasizes:
  - local privacy
  - search over local docs/code
  - easy MCP setup
- Threat to Recall:
  - not correction-memory specific
  - competes if users think "RAG over repo docs" is enough

### Claude Memory Context

- Repo: https://github.com/doobidoo/claude-memory-context
- Positioning: update Claude project instructions from MCP-backed memory
- What it emphasizes:
  - instruction-file updates
  - Claude project context maintenance
- Threat to Recall:
  - competes on the export/instruction-file angle

## What Recall Is Actually Good At

Recall is strongest when framed as:

- repo memory compiler for coding agents
- not generic chat memory
- not just vector search / RAG
- not just "save session transcript"

Differentiators already in the product:

- repo-specific correction memory
- quality / maturity gating
- promotion thresholds based on store quality
- scan + correction + compile in one system
- CLI + daemon + MCP + export
- explicit activity/session tracking
- local SQLite-first setup

## Main Market Risk

If Recall is described as:

- "memory for Claude/Codex"

then it lands in a crowded bucket.

If Recall is described as:

- "repo instruction compiler that learns from corrections and operational feedback"

then it becomes more distinct.

## How To Stay In The Market

### 1. Own the coding-repo lane

Do not compete as generic agent memory.

Compete as:

- memory for build/test/tooling conventions
- memory for team coding preferences
- memory that becomes injectible instructions

### 2. Make quality better than competitors

Most memory tools capture too much and get noisy.

Recall should win on:

- fewer wrong injections
- explainable promotion
- clear health / quality score
- visible activity history

### 3. Be the best at repo bootstrap

Cold start must feel useful fast.

That means:

- first scan gives useful active memories
- repo package manager / scripts / CI become available immediately
- compile pack is useful without manual cleanup

### 4. Lean into observability

This is now one of Recall’s strongest angles.

Keep pushing:

- session history
- what was injected
- what was followed / overridden
- what changed confidence
- why a memory was included or dropped

Users trust memory systems more when they can inspect them.

### 5. Make integrations feel native

The winning path is:

- MCP for live query
- daemon for local hooks
- export for file-based instruction systems

Do not force only one path.

### 6. Ship team / org workflows

Longer-term moat:

- shared team memory
- approval / policy
- repo-level vs team-level rules
- managed rollout of trusted memories

This can move Recall from solo utility to team infra.

## Best Near-Term Positioning

Suggested one-line positioning:

> Recall is a local repo-memory compiler for coding agents that learns from corrections, scores memory quality, and injects only trusted instructions.

Suggested short comparison:

- not a transcript archive
- not generic vector memory
- not just project instructions
- a learned instruction layer for coding workflows

## Immediate Product Priorities

1. Better cold-start bootstrap
2. Clear "why injected / why dropped" explanations
3. Activity/session history UX
4. Strong Claude/Codex MCP docs
5. Team-shared memory and policy workflows
