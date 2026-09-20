declare const __RECALL_BUILD_INFO__: {
  sha: string | null;
  built_at: string | null;
  dependencies: Record<string, string>;
};

const fallback = {
  sha: null,
  built_at: null,
  dependencies: {},
};

export const recallBuildInfo = typeof __RECALL_BUILD_INFO__ === "undefined"
  ? fallback
  : __RECALL_BUILD_INFO__;
