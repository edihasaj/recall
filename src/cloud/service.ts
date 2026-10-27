import { hostname } from "node:os";
import { isAbsolute, relative } from "node:path";
import {
  buildChildEnv,
  buildEngineArgs,
  loadCloudConfig,
  saveCloudConfig,
  validateApi,
  type CloudConfig,
} from "./config.js";
import { resolveEngineFiles, type EngineFiles } from "./engine.js";
import { CloudError } from "./errors.js";
import { isCloudQueryEnabled, setCloudQueryEnabled } from "./query-settings.js";
import { LegacyLaunchd, type LegacyLoadedState, type LegacySettings } from "./legacy.js";
import { DEFAULT_CLOUD_API, resolveCloudPaths, type CloudPaths } from "./paths.js";
import {
  ensurePrivateDir,
  normalizePassphrase,
  normalizeSecret,
  readPrivatePassphrase,
  readPrivateSecret,
  removeFile,
  writePrivateFile,
} from "./private-files.js";
import { requestFullReconcile } from "./state.js";
import { CloudWorker, type WorkerLike, type WorkerStatus } from "./worker.js";

export interface LegacyLike {
  plistExists(): boolean;
  loadedState(): LegacyLoadedState;
  readSettings(): LegacySettings;
  bootoutAndProve(): Promise<void>;
  retirePlist(): string;
}

export type CloudState =
  | "unavailable" | "disconnected" | "migration-pending"
  | "stopped" | "starting" | "running" | "backoff" | "failed";

/** Everything here is safe to show in the UI: no tokens, passphrases or engine output. */
export interface CloudStatus {
  available: boolean;
  state: CloudState;
  enabled: boolean;
  worker: Pick<WorkerStatus, "pid" | "startedAt" | "restarts" | "lastExit" | "lastSyncAt">;
  config: {
    api: string;
    deviceId: string;
    intervalSeconds: number;
    e2ee: boolean;
    migratedFrom: "legacy-launchd" | null;
    optInAt: string | null;
    queryEnrichment: boolean;
  } | null;
  legacy: { detected: boolean; loaded: boolean; unknown: boolean; canMigrate: boolean };
  error: string | null;
}

export interface ConnectInput {
  token?: unknown;
  e2eePassphrase?: unknown;
  api?: unknown;
  deviceId?: unknown;
  optIn?: unknown;
}

export interface CloudServiceDeps {
  paths?: CloudPaths;
  env?: NodeJS.ProcessEnv;
  worker?: WorkerLike;
  legacy?: LegacyLike;
  engine?: () => EngineFiles;
  nodePath?: string;
  osHostname?: () => string;
  now?: () => Date;
  log?: (message: string) => void;
}

function safeMessage(error: unknown): string {
  return error instanceof CloudError ? error.message : "Cloud sync could not be started";
}

function isInside(directory: string, file: string): boolean {
  const rel = relative(directory, file);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Owns the optional Recall Cloud sync inside the Recall daemon. With no config
 * file, or a disabled one, nothing is spawned and no network request is made.
 * The only background process is one bounded child, created after an explicit
 * in-app Connect or Migrate.
 */
export class CloudService {
  readonly paths: CloudPaths;
  private readonly env: NodeJS.ProcessEnv;
  private readonly worker: WorkerLike;
  private readonly legacy: LegacyLike;
  private readonly engineFn: () => EngineFiles;
  private readonly nodePath: string;
  private readonly osHostname: () => string;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private chain: Promise<unknown> = Promise.resolve();
  private startError: string | null = null;

  constructor(deps: CloudServiceDeps = {}) {
    this.env = deps.env ?? process.env;
    this.paths = deps.paths ?? resolveCloudPaths(this.env);
    this.log = deps.log ?? (() => {});
    this.worker = deps.worker ?? new CloudWorker({ log: this.log });
    this.legacy = deps.legacy ?? new LegacyLaunchd({ paths: this.paths });
    this.engineFn = deps.engine ?? (() => resolveEngineFiles());
    this.nodePath = deps.nodePath ?? process.execPath;
    this.osHostname = deps.osHostname ?? hostname;
    this.now = deps.now ?? (() => new Date());
  }

  /** The Mac App Store edition never syncs to the cloud. */
  available(): boolean {
    return this.env.RECALL_DISTRIBUTION !== "mac-app-store";
  }

  status(): CloudStatus {
    const available = this.available();
    let config: CloudConfig | null = null;
    let error: string | null = null;
    if (available) {
      try {
        config = loadCloudConfig(this.paths);
      } catch (e) {
        error = safeMessage(e);
      }
    }
    const worker = this.worker.status();
    const detected = available && this.legacy.plistExists();
    const loadedState = detected ? this.legacy.loadedState() : "absent";
    const loaded = loadedState === "loaded";
    const unknown = loadedState === "unknown";
    let state: CloudState;
    if (!available) state = "unavailable";
    else if (error) state = "failed";
    else if (config?.migrationPending) state = "migration-pending";
    else if (!config || !config.enabled) state = "disconnected";
    else if (worker.state === "failed" || (worker.state === "stopped" && this.startError)) state = "failed";
    else state = worker.state;
    if (state === "failed" && !error) error = this.startError ?? worker.lastError;
    else if (state === "backoff" || state === "running" || state === "starting") error = worker.lastError;
    return {
      available,
      state,
      enabled: Boolean(config?.enabled),
      worker: { pid: worker.pid, startedAt: worker.startedAt, restarts: worker.restarts, lastExit: worker.lastExit, lastSyncAt: worker.lastSyncAt },
      config: config
        ? {
            api: config.api,
            deviceId: config.deviceId,
            intervalSeconds: config.intervalSeconds,
            e2ee: config.e2ee,
            migratedFrom: config.migratedFrom,
            optInAt: config.optInAt,
            queryEnrichment: isCloudQueryEnabled(config, this.env),
          }
        : null,
      legacy: { detected, loaded, unknown, canMigrate: available && detected && !config?.enabled },
      error,
    };
  }

  setQueryEnrichment(enabled: unknown): Promise<CloudStatus> {
    return this.exclusive(async () => {
      if (typeof enabled !== "boolean") throw new CloudError("Online retrieval enabled must be a boolean", "invalid");
      setCloudQueryEnabled(enabled, this.env, this.paths);
      return this.status();
    });
  }

  /** Called once when the daemon is listening. No config, or disabled, means a no-op. */
  startIfEnabled(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.available()) return;
      let config: CloudConfig | null;
      try {
        config = loadCloudConfig(this.paths);
      } catch (e) {
        this.startError = safeMessage(e);
        return;
      }
      if (!config || !config.enabled) return;
      this.launchSafely(config);
    });
  }

  connect(input: ConnectInput): Promise<CloudStatus> {
    return this.exclusive(async () => {
      this.assertAvailable();
      if (input.optIn !== true) {
        throw new CloudError("Confirm that you want to sync this Mac to Recall Cloud first", "opt-in-required");
      }
      const engine = this.engineFn();
      void engine;
      const token = normalizeSecret(String(input.token ?? "").trim(), "token");
      const typedPassphrase = input.e2eePassphrase == null || input.e2eePassphrase === ""
        ? null
        : normalizePassphrase(input.e2eePassphrase);
      const existing = loadCloudConfig(this.paths);
      this.assertNoLegacy();

      let passphrase = typedPassphrase;
      if (!passphrase && existing?.e2ee) {
        try {
          passphrase = existing.passphraseFile ? readPrivatePassphrase(existing.passphraseFile) : null;
        } catch {
          passphrase = null;
        }
        if (!passphrase) {
          throw new CloudError(
            "This Mac previously used end-to-end encryption. Enter the same passphrase to reconnect; Recall will not sync unencrypted.",
            "encryption-required",
            409,
          );
        }
      }
      const api = validateApi(input.api ?? existing?.api ?? DEFAULT_CLOUD_API);
      const deviceId = String(input.deviceId ?? existing?.deviceId ?? this.defaultDeviceId()).trim();
      if (!deviceId || deviceId.includes(":") || deviceId.length > 200) {
        throw new CloudError("Invalid device name", "invalid");
      }

      await this.stopWorker();
      // Durably off before any credential is replaced: a failed write below can
      // never leave an enabled config pointing at a half-replaced token.
      if (existing?.enabled) saveCloudConfig(this.paths, { ...existing, enabled: false });
      ensurePrivateDir(this.paths.cloudDir);
      writePrivateFile(this.paths.tokenFile, token);
      if (passphrase) writePrivateFile(this.paths.passphraseFile, passphrase);
      const config: CloudConfig = {
        version: 1,
        enabled: true,
        ...(existing?.queryEnrichment === undefined ? {} : {
          queryEnrichment: existing.queryEnrichment,
        }),
        optInAt: this.now().toISOString(),
        api,
        deviceId,
        deviceAliases: existing?.deviceAliases ?? {},
        intervalSeconds: existing?.intervalSeconds ?? 300,
        fullReconcileSeconds: existing?.fullReconcileSeconds ?? null,
        statuses: existing?.statuses ?? null,
        limit: existing?.limit ?? null,
        rejectedRetentionDays: existing?.rejectedRetentionDays ?? null,
        dbPath: existing?.dbPath ?? this.paths.dbFile,
        stateFile: existing?.stateFile ?? this.paths.stateFile,
        tokenFile: this.paths.tokenFile,
        e2ee: passphrase !== null,
        passphraseFile: passphrase ? this.paths.passphraseFile : null,
        migratedFrom: existing?.migratedFrom ?? null,
        migrationPending: false,
      };
      // The token may belong to another account: re-verify everything once, keep cursors/identity.
      // Done before enabling, so a failure here leaves sync disabled.
      requestFullReconcile(config);
      saveCloudConfig(this.paths, config);
      this.launchSafely(config);
      return this.status();
    });
  }

  /** Stops the worker first and reports success only once the child has exited. */
  disconnect(): Promise<CloudStatus> {
    return this.exclusive(async () => {
      await this.stopWorker();
      this.startError = null;
      let existing: CloudConfig | null = null;
      try {
        existing = loadCloudConfig(this.paths);
      } catch {
        existing = null;
      }
      if (existing) {
        saveCloudConfig(this.paths, { ...existing, enabled: false, migrationPending: false });
        const { cloudDir } = this.paths;
        // The legacy job may still reference the token; never pull it out from under a live job.
        if (isInside(cloudDir, existing.tokenFile) && !this.legacy.plistExists()) removeFile(existing.tokenFile);
        if (existing.passphraseFile && isInside(cloudDir, existing.passphraseFile)) removeFile(existing.passphraseFile);
      }
      return this.status();
    });
  }

  /**
   * Explicit user action only. Stages the new config disabled, stops the legacy
   * job and requires launchd to prove it is gone, retires its plist, and only
   * then enables and starts the in-daemon worker. Any failure leaves the worker off.
   */
  migrateLegacy(input: { optIn?: unknown }): Promise<CloudStatus> {
    return this.exclusive(async () => {
      this.assertAvailable();
      if (input.optIn !== true) {
        throw new CloudError("Confirm that you want to move sync into Recall first", "opt-in-required");
      }
      this.engineFn();
      if (!this.legacy.plistExists()) {
        throw new CloudError("No existing Recall Cloud Sync job was found on this Mac", "legacy-missing", 404);
      }
      await this.stopWorker();
      const legacy = this.legacy.readSettings();
      readPrivateSecret(legacy.tokenFile, "token");
      let passphraseFile: string | null = null;
      if (legacy.e2ee && legacy.passphrase) {
        ensurePrivateDir(this.paths.cloudDir);
        writePrivateFile(this.paths.passphraseFile, normalizePassphrase(legacy.passphrase));
        passphraseFile = this.paths.passphraseFile;
      }
      const staged: CloudConfig = {
        version: 1,
        enabled: false,
        optInAt: null,
        api: legacy.api,
        deviceId: legacy.deviceId,
        deviceAliases: legacy.deviceAliases,
        intervalSeconds: legacy.intervalSeconds,
        fullReconcileSeconds: legacy.fullReconcileSeconds,
        statuses: legacy.statuses,
        limit: legacy.limit,
        rejectedRetentionDays: legacy.rejectedRetentionDays,
        dbPath: legacy.dbPath,
        stateFile: legacy.stateFile,
        tokenFile: legacy.tokenFile,
        e2ee: legacy.e2ee,
        passphraseFile,
        migratedFrom: "legacy-launchd",
        migrationPending: true,
      };
      saveCloudConfig(this.paths, staged);
      await this.legacy.bootoutAndProve();
      this.legacy.retirePlist();
      const final: CloudConfig = { ...staged, enabled: true, optInAt: this.now().toISOString(), migrationPending: false };
      saveCloudConfig(this.paths, final);
      this.launchSafely(final);
      return this.status();
    });
  }

  async shutdown(): Promise<void> {
    await this.exclusive(async () => {
      try {
        await this.worker.stop();
      } catch {
        this.worker.killSync();
      }
    });
  }

  /** Synchronous last resort for the process 'exit' event. */
  killSync(): void {
    this.worker.killSync();
  }

  private launchSafely(config: CloudConfig): void {
    try {
      this.startError = null;
      this.launch(config);
    } catch (e) {
      this.startError = safeMessage(e);
      this.log(`[recall-cloud] not started: ${this.startError}`);
    }
  }

  private launch(config: CloudConfig): void {
    const engine = this.engineFn();
    this.assertNoLegacy();
    readPrivateSecret(config.tokenFile, "token");
    let passphrase: string | null = null;
    if (config.e2ee) {
      try {
        passphrase = readPrivatePassphrase(config.passphraseFile ?? "");
      } catch {
        throw new CloudError(
          "End-to-end encryption is on but its passphrase is unavailable, so sync was not started",
          "encryption-required",
          409,
        );
      }
    }
    this.worker.start({
      command: this.nodePath,
      args: [engine.wrapper, ...buildEngineArgs(config, engine.engine)],
      env: buildChildEnv(this.env, passphrase),
    });
  }

  /** Refuses to run beside the old separate job, so uploads can never be duplicated. */
  private assertNoLegacy(): void {
    if (this.legacy.plistExists()) {
      throw new CloudError(
        "The old Recall Cloud Sync job is still installed. Use Move sync into Recall first.",
        "legacy-active",
        409,
      );
    }
    const loaded = this.legacy.loadedState();
    if (loaded === "loaded") {
      throw new CloudError(
        "The old Recall Cloud Sync job is still running. Use Move sync into Recall first.",
        "legacy-active",
        409,
      );
    }
    if (loaded === "unknown") {
      // Uncertainty is not proof of absence: never start beside a possibly running legacy job.
      throw new CloudError(
        "Recall could not confirm that the old Recall Cloud Sync job is stopped, so sync was not started. Try again.",
        "legacy-active",
        409,
      );
    }
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new CloudError("Recall Cloud sync is not available in this edition", "unavailable", 403);
    }
  }

  private async stopWorker(): Promise<void> {
    try {
      await this.worker.stop();
    } catch {
      throw new CloudError("The sync process did not stop. Nothing was changed; try again.", "unavailable", 503);
    }
  }

  private defaultDeviceId(): string {
    return this.env.RECALL_CLOUD_DEVICE_ID ?? this.env.HOSTNAME ?? this.osHostname() ?? "local-device";
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}
