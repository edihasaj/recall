// Drives a Chromium window through the Recall web UI, recording video.
// Invoked by scripts/record-demo.sh — do not run directly.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const url = process.env.WEBUI_URL ?? "http://localhost:7891";
const outDir = process.env.RECORD_OUT ?? "/tmp/recall-demo";
const videoDir = join(outDir, "video");
mkdirSync(videoDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } },
  colorScheme: "dark",
});
const page = await ctx.newPage();

const settle = (ms = 1100) => page.waitForTimeout(ms);

async function visit(path, hold = 2200) {
  await page.goto(url + path, { waitUntil: "networkidle" });
  await settle(hold);
}

await visit("/", 1800);
await visit("/memories", 2400);
await visit("/graph", 3200);
// Nudge the graph (zoom + drag) so it feels alive on the gif.
await page.mouse.move(720, 450);
await page.mouse.wheel(0, -300);
await settle(800);
await page.mouse.down();
await page.mouse.move(900, 500, { steps: 20 });
await page.mouse.up();
await settle(1500);
await visit("/sessions", 2000);
await visit("/timeline", 2000);
await visit("/contradictions", 1800);

await ctx.close();
await browser.close();
