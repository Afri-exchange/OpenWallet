// Records the demo as a video: opens the workflow in the n8n editor, presses Execute workflow, waits for it to
// finish and opens the final "Demo summary" node. Output: <outDir>/n8n-demo.webm (and .mp4 if ffmpeg exists).
//
// Usage: node record.mjs <outDir>   (run from anywhere; needs `playwright-core` and Chrome/Chromium)
// Env:   N8N_URL (default http://127.0.0.1:5678)   N8N_EMAIL / N8N_PASSWORD  (an n8n owner; if the instance has
//        no owner yet, one is created with these)   CHROME_PATH (optional)   WORKFLOW_ID (default agentCardsDemo0001)
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const out = resolve(process.argv[2] ?? ".");
const base = process.env.N8N_URL ?? "http://127.0.0.1:5678";
const email = process.env.N8N_EMAIL, password = process.env.N8N_PASSWORD;
const id = process.env.WORKFLOW_ID ?? "agentCardsDemo0001";
if (!email || !password) throw new Error("set N8N_EMAIL and N8N_PASSWORD");
mkdirSync(out, { recursive: true });

// create the owner if this is a fresh instance (ignore "already set up")
await fetch(`${base}/rest/owner/setup`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ email, firstName: "Demo", lastName: "Owner", password }) }).catch(() => {});

const chrome = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find(existsSync);
const browser = await chromium.launch({ executablePath: chrome, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 810 }, recordVideo: { dir: out, size: { width: 1440, height: 810 } } });
const page = await ctx.newPage();
const pause = (ms) => page.waitForTimeout(ms);

await page.goto(`${base}/signin`);
await page.getByLabel(/email/i).fill(email);
await page.locator('input[type="password"]').fill(password);
await page.getByRole("button", { name: /sign in/i }).click();
await page.waitForURL(/home|workflows|workflow/, { timeout: 30000 });
await page.goto(`${base}/workflow/${id}`);
await page.locator('[data-test-id="canvas-node"]').first().waitFor({ timeout: 30000 });
// dismiss any first-run popups
for (const t of [/skip|got it|close|no thanks/i]) { const b = page.getByRole("button", { name: t }).first(); if (await b.isVisible().catch(() => false)) await b.click().catch(() => {}); }
await pause(3500);                                   // let viewers read the flow
await page.getByRole("button", { name: /execute workflow/i }).first().click();
// finished when the last node shows a success tick
await page.locator('[data-test-id="canvas-node"][data-node-name="Demo summary"] [data-test-id="canvas-node-status-success"]').waitFor({ timeout: 240000 });
await pause(2500);
await page.locator('[data-test-id="canvas-node"][data-node-name="Demo summary"]').dblclick();
await pause(5000);                                   // output panel: PAID / stripe paid / demoPassed true
await ctx.close(); await browser.close();

const webm = readdirSync(out).filter((f) => f.endsWith(".webm")).map((f) => join(out, f)).at(-1);
renameSync(webm, join(out, "n8n-demo.webm"));
try {
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", join(out, "n8n-demo.webm"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "28", "-movflags", "+faststart", join(out, "n8n-demo.mp4")]);
  console.log("wrote", join(out, "n8n-demo.mp4"));
} catch { console.log("wrote", join(out, "n8n-demo.webm"), "(no ffmpeg: no mp4)"); }
