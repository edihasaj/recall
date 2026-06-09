import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pin the regex capture path on by default in tests. The LLM-primary path
    // is opt-in via dedicated tests that mock the LLM (or via an env override)
    // — production behavior auto-detects credentials, but tests run on machines
    // with real Azure/OpenAI keys in keychain and would otherwise enqueue
    // tasks instead of writing memories synchronously.
    env: {
      RECALL_LLM_CAPTURE_DISABLED: "true",
      // Hermetic repo discovery: without this, session-start bootstrap walks
      // ~/Projects on the dev machine, finds the real checkout matching the
      // test's repo slug, scans it, and seeds memories into "fresh" test DBs
      // (tests then fail locally but pass in CI, which has no ~/Projects).
      // Tests that exercise discovery pass explicit searchRoots.
      RECALL_REPO_ROOTS: "/nonexistent-recall-test-repo-roots",
    },
  },
});
