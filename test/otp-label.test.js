// Checks the account label added to each portal page and the panel's OTP bar.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "patchright";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// The same init script src/index.js installs, read straight from the source
// so the test follows any change to it.
async function labelInitScript() {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(path.join(ROOT, "src", "index.js"), "utf8");
  const match = source.match(/await context\.addInitScript\((\(\{ account, maskedNumber \}\) => \{[\s\S]*?\n {4}\}), \{/);
  assert.ok(match, "label script found in src/index.js");
  return match[1];
}

test("each portal page shows the account and the number its OTP goes to, and keeps it through page changes", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext();
    const script = await labelInitScript();
    await context.addInitScript(`(${script})(${JSON.stringify({ account: "user2", maskedNumber: "019••••••82" })})`);
    await context.route("https://ivac.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><title>Indian Visa Application Center</title><div id="root"><h1>Verify OTP</h1></div>
      <script>setTimeout(() => { document.title = "Indian Visa Application Center"; document.getElementById("root").innerHTML = "<h1>Next page</h1>"; }, 300);</script>` }));
    const page = await context.newPage();
    await page.goto("https://ivac.test/verify-login-phone-otp");
    await page.waitForTimeout(800);
    const label = await page.locator("#ivac-account-label");
    assert.equal(await label.textContent(), "user2 • OTP goes to 019••••••82");
    assert.equal(await label.isVisible(), true);
    assert.equal(await page.title(), "[user2] Indian Visa Application Center", "title keeps the account after the page changes it");
    assert.equal(await label.evaluate((node) => getComputedStyle(node).pointerEvents), "none", "never blocks clicks");
  } finally {
    await browser.close();
  }
});

test("panel shows which accounts wait for an OTP and the number it went to", { timeout: 90_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ivac-otp-bar-"));
  const port = 4500 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  const credentials = path.join(dir, "credentials.json");
  await writeFile(credentials, JSON.stringify({ user2: { contactNumber: "01900000082", password: "pw" } }));
  const docs = path.join(dir, "doc_file", "user2");
  await (await import("node:fs/promises")).mkdir(docs, { recursive: true });
  await writeFile(path.join(docs, "01 A.pdf"), "%PDF-1.4\n");
  const server = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
    env: { ...process.env, IVAC_CREDENTIALS: credentials, IVAC_DOC_ROOT: path.join(dir, "doc_file"), IVAC_PANEL_PORT: String(port), IVAC_PANEL_NO_OPEN: "1", IVAC_RUNNER: path.join(ROOT, "test", "fixtures", "fake-runner.js"), IVAC_STAGGER_SECONDS: "0" },
    stdio: "ignore",
  });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !(await fetch(`${base}/api/state`).then((r) => r.ok).catch(() => false))) await new Promise((r) => setTimeout(r, 200));
    const page = await browser.newPage();
    await page.goto(base);
    await fetch(`${base}/api/accounts/user2/start`, { method: "POST", headers: { "x-ivac-panel": "1" } });
    await page.locator("#otpBar:not([hidden])").waitFor({ timeout: 20_000 });
    const text = (await page.locator("#otpBarList").innerText()).replace(/\s+/g, " ");
    assert.match(text, /user2 → 019•+82/);
    const state = await fetch(`${base}/api/state`).then((r) => r.json());
    assert.ok(state.accounts[0].otpSince, "server reports since when the OTP is awaited");
    assert.match(await page.locator(".otpFor").first().innerText(), /for user2 → 019•+82/);
  } finally {
    await browser.close();
    server.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
