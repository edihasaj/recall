# Recall Architecture

Recall is a local memory system for coding agents.

It does 4 core things:

1. collect repo facts and user corrections
2. store them as memories in SQLite
3. compile the best memories into a small context pack
4. expose that pack to tools like Claude/Codex through MCP, exports, or the local daemon

## High-Level System

```mermaid
flowchart LR
    User[User / Agent]
    CLI[CLI]
    MCP[MCP Server]
    Daemon[HTTP Daemon]
    Browser[Browser Extension]
    Export[CLAUDE.md / AGENTS.md Export]
    Compiler[Context Compiler]
    Capture[Correction / Review Capture]
    Scanner[Repo Scanner]
    Models[Models]
    DB[(SQLite recall.db)]

    User --> CLI
    User --> MCP
    User --> Browser

    CLI --> Scanner
    CLI --> Capture
    CLI --> Compiler

    MCP --> Capture
    MCP --> Compiler
    MCP --> Models

    Browser --> Daemon
    Daemon --> Capture
    Daemon --> Compiler
    Daemon --> Models

    Scanner --> Models
    Capture --> Models
    Compiler --> Models
    Models --> DB

    Compiler --> Export
```

## Main Data Model

Recall stores a few related layers:

- `memories`: rules, commands, gotchas, decisions, review patterns
- `feedback_events`: whether injected memories were followed, overridden, ignored, contradicted
- `implicit_signals`: test/file/task quality signals
- `activity_events`: session/query/call history
- `eval_sessions`: aggregate effectiveness metrics
- `audit_trail`: mutation history
- `contradictions`: detected conflicts
- `policy_rules` / `approval_requests`: org governance

```mermaid
erDiagram
    MEMORIES ||--o{ FEEDBACK_EVENTS : receives
    MEMORIES ||--o{ IMPLICIT_SIGNALS : receives
    MEMORIES ||--o{ AUDIT_TRAIL : tracked_by
    MEMORIES ||--o{ CONTRADICTIONS : conflicts_with
    MEMORIES ||--o{ APPROVAL_REQUESTS : may_require

    ACTIVITY_EVENTS {
      string id
      string session_id
      string repo
      string path
      string source
      string event_type
      json memory_ids
      json request
      json result
      string created_at
    }

    MEMORIES {
      string id
      string type
      string text
      string scope
      string repo
      string status
      number confidence
      string source
    }

    FEEDBACK_EVENTS {
      string id
      string memory_id
      string session_id
      bool injected
      string outcome
      string timestamp
    }

    IMPLICIT_SIGNALS {
      string id
      string memory_id
      string session_id
      string signal_type
      string timestamp
    }
```

## Memory Lifecycle

```mermaid
flowchart TD
    A[Repo Scan / User Correction / Review Feedback] --> B[Create Memory]
    B --> C{Confidence}
    C -->|lt 0.3| T[Transient]
    C -->|0.3 - lt 0.6| K[Candidate]
    C -->|ge 0.6| D[Active]

    K --> E[Repeat evidence / confirm / review / passive gain]
    E --> D

    D --> F[Injected into context]
    F --> G[Feedback events + implicit signals]
    G --> H{Outcome}
    H -->|positive| I[Promote / validate]
    H -->|negative| J[Demote / reject]

    D --> L[Contradiction detection]
    D --> M[Pruning / archival]
    D --> N[Audit trail]
```

## Capture Flow

User feedback enters through CLI, daemon, or MCP.

Examples:

- `don't use npm, use pnpm`
- `review said use error boundaries`

The capture layer:

1. parses the text into one or more structured corrections
2. infers scope: path / repo / team
3. checks for duplicates
4. applies repo-quality-aware thresholds
5. creates or promotes memories

```mermaid
flowchart LR
    Input[Correction / Review Text]
    Detect[Pattern Detection]
    Scope[Scope Inference]
    Dedup[Duplicate Match]
    Quality[Repo Quality Profile]
    Memory[Create / Update Memory]

    Input --> Detect --> Scope --> Dedup --> Quality --> Memory
```

## Scan Flow

Repo scan reads:

- `package.json`
- lockfiles
- Makefiles
- CI config
- instruction files like `AGENTS.md`
- README setup commands
- Python project files

Trusted scan facts now bootstrap better than before:

- operational config-based commands can start active on cold repos
- softer scan facts stay candidate or get dropped if they look generic
- repeated scans dedupe and upgrade stale scan-created memories
- maintenance re-checks older scan-created memories and self-heals noisy rows

```mermaid
flowchart LR
    Repo[Repository Files]
    Scan[Repo Scanner]
    Parse[Extract Commands / Rules / Gotchas]
    Quality[Repo Quality Seeding]
    Upsert[Create or Upgrade Scan Memories]
    DB[(SQLite)]

    Repo --> Scan --> Parse --> Quality --> Upsert --> DB
```

## Compile Flow

Compilation is what actually turns stored memories into injected context.

Steps:

1. load active memories for repo
2. filter by path scope
3. apply dynamic confidence threshold from repo quality
4. sort by type + confidence
5. fit into token/line budgets
6. render pack

```mermaid
flowchart TD
    A[Repo + optional path] --> B[Load active memories]
    B --> C[Path filtering]
    C --> D[Dynamic confidence gate]
    D --> E[Sort by priority + confidence]
    E --> F[Budget trim]
    F --> G[Render Rules / Commands / Gotchas]
    G --> H[Compiled context pack]
```

## Repo Quality / Maturity

Repo quality affects how strict Recall is.

Signals used:

- active memory count
- average health
- override rate
- contradiction rate

Outputs:

- repeat sessions required before promotion
- compile confidence threshold
- dedup similarity threshold

```mermaid
flowchart LR
    Active[Active Count]
    Health[Avg Health]
    Override[Override Rate]
    Conflict[Contradiction Rate]

    Active --> Score[Repo Quality Score]
    Health --> Score
    Override --> Score
    Conflict --> Score

    Score --> Promotion[Repeat Sessions Needed]
    Score --> Compile[Compile Threshold]
    Score --> Dedup[Dedup Threshold]
```

## How It Reaches Claude / Codex

There are 3 integration paths.

### 1. MCP Query Path

This is the most direct path for coding agents.

Agent asks Recall:

- `query`
- `report_correction`
- `report_review`
- `feedback`
- `activity`
- `sessions`

```mermaid
sequenceDiagram
    participant Agent as Claude / Codex
    participant MCP as Recall MCP
    participant Compiler as Compiler
    participant DB as SQLite

    Agent->>MCP: query(repo, path, session_id)
    MCP->>Compiler: compileContext(...)
    Compiler->>DB: load active memories
    DB-->>Compiler: memories
    Compiler-->>MCP: compiled pack
    MCP->>DB: log activity_event(query)
    MCP-->>Agent: context text
```

### 2. Exported Instruction Files

These are optional exports/fallbacks. Primary live integration should use MCP.

Recall can generate instruction files or repo-local context artifacts for tools that read repo-local docs:

- `CLAUDE.md`
- `AGENTS.md`
- `.recall/context.md`
- plain Markdown

```mermaid
flowchart LR
    DB[(SQLite Memories)] --> Compiler[Compiler]
    Compiler --> Export[Export Adapter]
    Export --> Claude[CLAUDE.md]
    Export --> Codex[AGENTS.md]
    Export --> Context[.recall/context.md]
```

### 3. Local Daemon / Browser Hook

The daemon exposes HTTP endpoints like:

- `/compile`
- `/correct`
- `/review`
- `/activity`
- `/sessions`

The browser extension can ask the daemon for compiled memories and report corrections.

```mermaid
sequenceDiagram
    participant UI as Browser / Local Tool
    participant Daemon as Recall Daemon
    participant Compiler as Compiler
    participant DB as SQLite

    UI->>Daemon: POST /compile
    Daemon->>Compiler: compileContext(...)
    Compiler->>DB: load memories
    DB-->>Compiler: active memories
    Compiler-->>Daemon: compiled pack
    Daemon->>DB: log activity_event(compile)
    Daemon-->>UI: compiled pack JSON
```

## Session / Activity Tracking

Recall now logs activity events so you can inspect what happened days later.

Each event can record:

- `session_id`
- repo
- source: `cli`, `daemon`, `mcp`
- event type: `compile`, `query`, `scan`, `correction`, `review`, `feedback`, `signal`
- affected memory ids
- request payload
- result payload

You can view it with:

```bash
recall activity -n 20
recall sessions -n 20
```

```mermaid
flowchart LR
    Action[CLI / MCP / Daemon Call]
    Activity[activity_events]
    Sessions[Session Grouping]
    Inspect[activity / sessions views]

    Action --> Activity --> Sessions --> Inspect
```

## Runtime / Process Model

Recall has 3 common runtime modes:

- one-shot CLI
- `launchd`-managed macOS daemon
- MCP stdio server

```mermaid
flowchart TD
    CLI[CLI Process] --> DB[(SQLite)]
    MCP[MCP Stdio Server] --> DB
    Launchd[launchd LaunchAgent] --> Daemon[Recall HTTP Daemon]
    Daemon --> DB
```

## Practical Summary

If you want to understand Recall quickly:

- scan and corrections create memories
- repo quality decides how strict promotion/injection should be
- compile turns active memories into a small pack
- MCP/daemon/export paths deliver that pack to agents
- activity log tells you what happened across sessions over time
