import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "patchright";
import { fillOtpAndVerify } from "../src/booking.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("fills the portal's six OTP boxes and clicks Verify OTP (structure from the live page)", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const boxes = Array.from({ length: 6 }, (_, i) => `<input id="otp-${i}" type="text" inputmode="numeric" maxlength="1" autocomplete="off" value="">`).join("");
    await page.setContent(`<form><h1>Verify OTP</h1><label>OTP</label><div>${boxes}</div>
      <div><button type="button" disabled>Resend OTP</button><span>Resend in 1:59</span></div>
      <button disabled type="submit" id="verify"><span>Verify OTP</span></button></form>
      <script>
        const inputs = [...document.querySelectorAll('input[id^="otp-"]')];
        const verify = document.querySelector('#verify');
        inputs.forEach((input) => input.addEventListener('input', () => { verify.disabled = !inputs.every((i) => i.value.length === 1); }));
        document.querySelector('form').addEventListener('submit', (event) => {
          event.preventDefault();
          document.documentElement.dataset.submitted = inputs.map((i) => i.value).join('');
        });
      </script>`);
    assert.equal(await fillOtpAndVerify(page, "48 21 97"), true);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.submitted), "482197");
  } finally {
    await browser.close();
  }
});

// --- control panel server, end to end, with a fake runner -------------------

function startServer(env) {
  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  return { child, output: () => output };
}

async function waitFor(check, timeout = 15_000, label = "condition") {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

test("control panel: add an account with PDFs, start it, send the OTP, answer, reach payment, stop", { timeout: 90_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ivac-panel-"));
  const port = 4500 + Math.floor(Math.random() * 400); // never 4370, the real panel
  const base = `http://127.0.0.1:${port}`;
  const credentials = path.join(dir, "credentials.json");
  const docs = path.join(dir, "doc_file");
  await writeFile(credentials, "{}\n");
  const server = startServer({
    IVAC_CREDENTIALS: credentials, IVAC_DOC_ROOT: docs, IVAC_PANEL_PORT: String(port), IVAC_PANEL_NO_OPEN: "1",
    IVAC_RUNNER: path.join(ROOT, "test", "fixtures", "fake-runner.js"), IVAC_STAGGER_SECONDS: "0",
  });
  const call = (method, url, body, headers = { "x-ivac-panel": "1" }) => fetch(`${base}${url}`, { method, headers: { ...headers, ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    await waitFor(() => fetch(`${base}/api/state`).then((r) => r.ok).catch(() => false), 15_000, "server");

    // The panel page is served.
    const html = await fetch(`${base}/`).then((r) => r.text());
    assert.match(html, /IVAC Booking Panel/);

    // Changes without the panel header (e.g. from another website) are refused.
    assert.equal((await call("POST", "/api/start-all", undefined, {})).status, 403);

    // Validation.
    const bad = new FormData();
    bad.append("name", "user1");
    bad.append("contactNumber", "12345");
    bad.append("password", "pw");
    bad.append("files", new Blob(["%PDF-1.4"]), "a.pdf");
    assert.match((await call("POST", "/api/accounts", bad)).body.error, /11 digits/);
    const notPdf = new FormData();
    notPdf.append("name", "user1");
    notPdf.append("contactNumber", "01700000001");
    notPdf.append("password", "pw");
    notPdf.append("files", new Blob(["hello"]), "notes.pdf");
    assert.match((await call("POST", "/api/accounts", notPdf)).body.error, /not a PDF/);

    // Add user1 with two PDFs: the first becomes 01 (Primary).
    const form = new FormData();
    form.append("name", "user1");
    form.append("contactNumber", "01700000001");
    form.append("password", "secret-pw");
    form.append("files", new Blob(["%PDF-1.4 primary"]), "SUMALA BGDKV14.pdf");
    form.append("files", new Blob(["%PDF-1.4 second"]), "02 OINDRILA.pdf");
    const saved = await call("POST", "/api/accounts", form);
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.account.docs.map((d) => d.file), ["01 SUMALA BGDKV14.pdf", "02 OINDRILA.pdf"]);
    assert.deepEqual(JSON.parse(await readFile(credentials, "utf8")), { user1: { contactNumber: "01700000001", password: "secret-pw" } });
    assert.deepEqual((await readdir(path.join(docs, "user1"))).sort(), ["01 SUMALA BGDKV14.pdf", "02 OINDRILA.pdf"]);

    // The panel never sends the full number or the password back.
    const stateText = await fetch(`${base}/api/state`).then((r) => r.text());
    assert.doesNotMatch(stateText, /01700000001|secret-pw/);

    // Start: the runner reaches the OTP page and asks for the OTP.
    assert.equal((await call("POST", "/api/accounts/user1/start")).status, 200);
    const accountState = async () => (await fetch(`${base}/api/state`).then((r) => r.json())).accounts.find((a) => a.name === "user1");
    await waitFor(async () => (await accountState()).state === "needs-otp", 15_000, "needs-otp");
    const needing = await accountState();
    assert.equal(needing.needsOtp, true);
    assert.equal(needing.page.key, "otp");
    assert.equal(needing.step, "Sign In");

    // Send the OTP from the panel; the runner gets it and moves on.
    assert.equal((await call("POST", "/api/accounts/user1/otp", { code: "123456" })).status, 200);
    await waitFor(async () => (await accountState()).question, 15_000, "question");
    const asked = await accountState();
    assert.equal(asked.question.text, "Mission number:");
    assert.equal(asked.otpStatus, "verified");
    assert.ok(asked.logs.some((entry) => /OTP with 6 digits filled in/.test(entry.text)));

    // Answer the question; the runner reaches the payment page.
    assert.equal((await call("POST", "/api/accounts/user1/answer", { id: asked.question.id, text: "1" })).status, 200);
    await waitFor(async () => (await accountState()).state === "payment", 15_000, "payment");
    const paid = await accountState();
    assert.deepEqual(paid.pages.map((p) => p.key), ["otp", "mission", "payment"]);
    assert.ok(paid.logs.some((entry) => /Mission answer: 1$/.test(entry.text)));

    // Stop.
    assert.equal((await call("POST", "/api/accounts/user1/stop")).status, 200);
    await waitFor(async () => !(await accountState()).active, 15_000, "stopped");
  } finally {
    server.child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("control panel UI: multi-PDF slot upload, edit keeps existing PDFs, add & promote Primary", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ivac-panel-ui-"));
  const port = 4500 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  const credentials = path.join(dir, "credentials.json");
  const docs = path.join(dir, "doc_file");
  const pdf1 = path.join(dir, "PARIMAL.pdf");
  const pdf2 = path.join(dir, "MENOTY.pdf");
  const pdf3 = path.join(dir, "ALAMIN.pdf");
  await writeFile(credentials, "{}\n");
  await writeFile(pdf1, "%PDF-1.4 one");
  await writeFile(pdf2, "%PDF-1.4 two");
  await writeFile(pdf3, "%PDF-1.4 three");

  const server = startServer({
    IVAC_CREDENTIALS: credentials,
    IVAC_DOC_ROOT: docs,
    IVAC_PANEL_PORT: String(port),
    IVAC_PANEL_NO_OPEN: "1",
    IVAC_RUNNER: path.join(ROOT, "test", "fixtures", "fake-runner.js"),
    IVAC_STAGGER_SECONDS: "20",
  });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    await waitFor(() => fetch(`${base}/api/state`).then((r) => r.ok).catch(() => false), 15_000, "server");
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.fill("#fName", "family1");
    await page.fill("#fNumber", "01711111111");
    await page.fill("#fPassword", "pass123");

    // Add 2 PDFs one-by-one using the hidden file input
    await page.setInputFiles("#fFiles", pdf1);
    await page.setInputFiles("#fFiles", pdf2);
    assert.equal(await page.locator("#pdfCountPill").innerText(), "2 / 4 PDFs");
    assert.equal(await page.locator("#fileList .slot-item").count(), 2);
    assert.match(await page.locator("#addNextSlotBtn").innerText(), /Add Co-Applicant 03 PDF/);

    await page.click("#saveBtn");
    await waitFor(async () => (await page.locator(".acct").count()) === 1, 10_000, "account card");
    assert.deepEqual((await readdir(path.join(docs, "family1"))).sort(), ["01 PARIMAL.pdf", "02 MENOTY.pdf"]);

    // Click Edit: existing 2 PDFs must load into the form slots!
    await page.click('.acct [data-act="edit"]');
    assert.equal(await page.locator("#pdfCountPill").innerText(), "2 / 4 PDFs");
    assert.equal(await page.locator("#fileList .slot-item").count(), 2);

    // Add a 3rd PDF and promote it to Primary (Slot 01)
    await page.setInputFiles("#fFiles", pdf3);
    assert.equal(await page.locator("#pdfCountPill").innerText(), "3 / 4 PDFs");
    await page.locator("#fileList .slot-item").nth(2).locator("[data-primary]").click();

    await page.click("#saveBtn");
    await waitFor(
      async () => (await readdir(path.join(docs, "family1")).catch(() => [])).length === 3,
      10_000,
      "3 saved pdfs",
    );
    assert.deepEqual(
      (await readdir(path.join(docs, "family1"))).sort(),
      ["01 ALAMIN.pdf", "02 PARIMAL.pdf", "03 MENOTY.pdf"],
    );
    assert.deepEqual(pageErrors, [], "no JS runtime errors in panel UI");
  } finally {
    await browser.close();
    server.child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
