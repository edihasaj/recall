import { defineConfig } from "drizzle-kit";
import { homedir } from "node:os";
import { join } from "node:path";

const dataDir = process.env.RECALL_DATA_DIR ?? join(homedir(), ".recall");
const url = process.env.RECALL_DB_URL ?? join(dataDir, "recall.db");

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  url,
});
