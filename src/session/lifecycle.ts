import type { RecallDb } from "../db/client.js";
import { createActivityEvent } from "../models/activity.js";
import { ensureRepoBootstrapped, inferRepoSlugFromPath } from "../repo/discovery.js";
import { writeRepoContextArtifact } from "../artifacts/context.js";
import type { ActivitySource } from "../types.js";
import { tagActivitySource } from "../types.js";

export interface SessionLifecycleInput {
  session_id: string;
  client?: string | null;
  repo?: string | null;
  repo_path?: string | null;
  path?: string | null;
  meta?: Record<string, unknown>;
  source?: ActivitySource;
}

function resolveLifecycleSource(input: SessionLifecycleInput): ActivitySource {
  if (input.source) return input.source;
  return input.client ? tagActivitySource("hook", input.client) : "daemon";
}

export interface SessionLifecycleResult {
  session_id: string;
  repo: string | null;
  repo_path: string | null;
  bootstrap_status:
    | "skipped"
    | "already_known"
    | "bootstrapped"
    | "scanned_empty"
    | "unresolved";
  created_ids: string[];
}

export function startSessionLifecycle(
  db: RecallDb,
  input: SessionLifecycleInput,
): SessionLifecycleResult {
  const repo = input.repo ?? inferRepoSlugFromPath(input.repo_path) ?? null;
  const bootstrap = ensureRepoBootstrapped(db, {
    repo,
    repoPathHint: input.repo_path,
  });

  if (bootstrap.status === "bootstrapped" || bootstrap.status === "scanned_empty") {
    createActivityEvent(db, {
      session_id: input.session_id,
      repo: bootstrap.repo,
      path: input.path ?? null,
      source: resolveLifecycleSource(input),
      event_type: "scan",
      memory_ids: bootstrap.created_ids,
      request: {
        repo_path: bootstrap.repo_path,
        client: input.client ?? null,
        trigger: "session_start_bootstrap",
      },
      result: {
        created: bootstrap.created_ids.length,
        status: bootstrap.status,
      },
    });
  }

  const artifact = writeRepoContextArtifact(db, {
    repo: bootstrap.repo,
    repo_path: bootstrap.repo_path ?? input.repo_path ?? null,
  });

  createActivityEvent(db, {
    session_id: input.session_id,
    repo: bootstrap.repo,
    path: input.path ?? null,
    source: resolveLifecycleSource(input),
    event_type: "session_start",
    request: {
      client: input.client ?? null,
      repo_path: bootstrap.repo_path ?? input.repo_path ?? null,
      meta: input.meta ?? {},
    },
    result: {
      bootstrap_status: bootstrap.status,
      created: bootstrap.created_ids.length,
      artifact_path: artifact.output_path,
      artifact_written: artifact.written,
    },
  });

  return {
    session_id: input.session_id,
    repo: bootstrap.repo,
    repo_path: bootstrap.repo_path ?? input.repo_path ?? null,
    bootstrap_status: bootstrap.status,
    created_ids: bootstrap.created_ids,
  };
}

export function recordSessionLifecycleEvent(
  db: RecallDb,
  input: SessionLifecycleInput & {
    name: string;
    payload?: Record<string, unknown>;
  },
): SessionLifecycleResult {
  const repo = input.repo ?? inferRepoSlugFromPath(input.repo_path) ?? null;

  createActivityEvent(db, {
    session_id: input.session_id,
    repo,
    path: input.path ?? null,
    source: resolveLifecycleSource(input),
    event_type: "session_event",
    request: {
      client: input.client ?? null,
      name: input.name,
      repo_path: input.repo_path ?? null,
      meta: input.meta ?? {},
    },
    result: input.payload ?? {},
  });

  return {
    session_id: input.session_id,
    repo,
    repo_path: input.repo_path ?? null,
    bootstrap_status: "skipped",
    created_ids: [],
  };
}

export function endSessionLifecycle(
  db: RecallDb,
  input: SessionLifecycleInput & {
    payload?: Record<string, unknown>;
  },
): SessionLifecycleResult {
  const repo = input.repo ?? inferRepoSlugFromPath(input.repo_path) ?? null;

  createActivityEvent(db, {
    session_id: input.session_id,
    repo,
    path: input.path ?? null,
    source: resolveLifecycleSource(input),
    event_type: "session_end",
    request: {
      client: input.client ?? null,
      repo_path: input.repo_path ?? null,
      meta: input.meta ?? {},
    },
    result: input.payload ?? {},
  });

  return {
    session_id: input.session_id,
    repo,
    repo_path: input.repo_path ?? null,
    bootstrap_status: "skipped",
    created_ids: [],
  };
}
