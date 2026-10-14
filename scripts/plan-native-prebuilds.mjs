import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const runners = {
  linux: { os: "linux", x64: "ubuntu-22.04", arm64: "ubuntu-22.04-arm" },
  windows: { os: "win32", x64: "windows-2022", arm64: "windows-11-arm" },
  macos: { os: "darwin", x64: "macos-15-intel", arm64: "macos-14" },
};

/** Select only requested ABI targets; do not silently drop legacy support. */
export function planPrebuilds({
  nodeVersions = "22",
  platform = "linux",
  architecture = "x64",
} = {}) {
  if (typeof nodeVersions !== "string" || nodeVersions.length > 32) {
    throw new Error("node_versions must select 20, 22, or 24.");
  }
  const versions = [...new Set(nodeVersions.split(",").map((value) => value.trim()))];
  if (!versions.length || versions.some((value) => !["20", "22", "24"].includes(value))) {
    throw new Error("node_versions must select 20, 22, or 24.");
  }
  if (!["linux", "windows", "macos", "all"].includes(platform)) {
    throw new Error("platform must select linux, windows, macos, or all.");
  }
  if (!["x64", "arm64", "all"].includes(architecture)) {
    throw new Error("architecture must select x64, arm64, or all.");
  }
  const platforms = platform === "all" ? Object.keys(runners) : [platform];
  const architectures = architecture === "all" ? ["x64", "arm64"] : [architecture];
  return {
    include: platforms.flatMap((target) =>
      architectures.flatMap((arch) =>
        versions.map((node) => ({
          os: runners[target].os,
          arch,
          runner: runners[target][arch],
          node: Number(node),
        })),
      ),
    ),
  };
}

export function writePlan(env) {
  const matrix = planPrebuilds({
    nodeVersions: env.NODE_VERSIONS ?? "22",
    platform: env.TARGET_PLATFORM ?? "linux",
    architecture: env.TARGET_ARCHITECTURE ?? "x64",
  });
  if (!env.GITHUB_OUTPUT) throw new Error("GITHUB_OUTPUT is required.");
  appendFileSync(env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writePlan(process.env);
}
