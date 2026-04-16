import { getDbPath, getDbUserVersion, RECALL_DB_USER_VERSION } from "../db/client.js";
import { getEmbeddingModelInfo } from "../embeddings/embeddings.js";
import { getLaunchAgentStatus } from "../daemon/launchd.js";

export interface DoctorReport {
  db_path: string;
  db_user_version: number;
  db_target_version: number;
  embeddings: ReturnType<typeof getEmbeddingModelInfo>;
  launchd: {
    installed: boolean;
    loaded: boolean;
    state?: string;
  } | null;
}

export function getDoctorReport(): DoctorReport {
  const dbPath = getDbPath();
  const launchd = process.platform === "darwin"
    ? (() => {
        try {
          const status = getLaunchAgentStatus();
          return {
            installed: status.installed,
            loaded: status.loaded,
            state: status.state,
          };
        } catch {
          return null;
        }
      })()
    : null;

  return {
    db_path: dbPath,
    db_user_version: getDbUserVersion(dbPath),
    db_target_version: RECALL_DB_USER_VERSION,
    embeddings: getEmbeddingModelInfo(),
    launchd,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    "# Recall Doctor",
    "",
    `DB:        ${report.db_path}`,
    `DB ver:    ${report.db_user_version}/${report.db_target_version}`,
  ];

  if (report.embeddings) {
    lines.push(`Embed:     ${report.embeddings.provider}`);
    lines.push(`Model:     ${report.embeddings.model}`);
    lines.push(`Dims:      index=${report.embeddings.index_dimensions} canonical=${report.embeddings.canonical_dimensions}`);
    lines.push(`Cache:     ${report.embeddings.size_label} @ ${report.embeddings.cache_path}`);
  } else {
    lines.push("Embed:     disabled");
  }

  if (report.launchd) {
    lines.push(`Launchd:   ${report.launchd.installed ? "installed" : "missing"} / ${report.launchd.loaded ? "loaded" : "not loaded"}${report.launchd.state ? ` (${report.launchd.state})` : ""}`);
  }

  return lines.join("\n");
}
