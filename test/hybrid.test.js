import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserPool, shouldBlockRequest } from "../src/browser-pool.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { SessionLogger } from "../src/session-logger.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("BrowserPool shares browsers up to maxContextsPerBrowser and closes idle ones", async () => {
  let launched = 0;
  let closed = 0;
  const pool = new BrowserPool({
    maxContextsPerBrowser: 2,
    idleCloseMs: 0,
    launcher: async () => {
      launched += 1;
      const id = launched;
      return {
        wsEndpoint: () => `ws://mock-browser-${id}`,
        close: async () => { closed += 1; },
      };
    },
  });

  const s1 = await pool.acquire("user1");
  const s2 = await pool.acquire("user2");
  assert.equal(s1.wsEndpoint, s2.wsEndpoint, "user1 and user2 share browser #1");
  assert.equal(pool.stats().browsers, 1);
  assert.equal(pool.stats().activeContexts, 2);

  const s3 = await pool.acquire("user3");
  assert.notEqual(s3.wsEndpoint, s1.wsEndpoint, "user3 opens browser #2 when #1 is full");
  assert.equal(pool.stats().browsers, 2);
  assert.equal(pool.stats().activeContexts, 3);

  pool.release("user3");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pool.stats().browsers, 1, "idle browser #2 closed automatically");
  assert.equal(closed, 1);

  await pool.closeAll();
  assert.equal(pool.stats().browsers, 0);
  assert.equal(closed, 2);
});

test("asset blocker skips images/fonts/media/trackers while protecting IVAC API, Turnstile, and payment gateways", () => {
  assert.equal(shouldBlockRequest("image", "https://appointment.ivacbd.com/assets/bg.jpg"), true);
  assert.equal(shouldBlockRequest("font", "https://fonts.gstatic.com/s/inter.woff2"), true);
  assert.equal(shouldBlockRequest("media", "https://appointment.ivacbd.com/video.mp4"), true);
  assert.equal(shouldBlockRequest("script", "https://static.cloudflareinsights.com/beacon.min.js"), true);
  assert.equal(shouldBlockRequest("xhr", "https://www.google-analytics.com/g/collect"), true);

  // Must NEVER block portal docs/API, Cloudflare Turnstile, or payment gateways
  assert.equal(shouldBlockRequest("document", "https://appointment.ivacbd.com/appointment/file-upload"), false);
  assert.equal(shouldBlockRequest("xhr", "https://appointment.ivacbd.com/api/v1/login"), false);
  assert.equal(shouldBlockRequest("fetch", "https://appointment.ivacbd.com/api/v1/slots"), false);
  assert.equal(shouldBlockRequest("image", "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/img.png"), false);
  assert.equal(shouldBlockRequest("image", "https://securepay.sslcommerz.com/gwprocess/logo.png"), false);
  assert.equal(shouldBlockRequest("image", "https://tokenized.pay.bka.sh/qr.png"), false);
});

test("SessionLogger persists unlimited log lines, API metrics, and session summary to disk", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ivac-slog-"));
  try {
    const logger = new SessionLogger(dir);
    logger.startSession("user1", { poolMode: true, blockAssets: true });
    logger.writeLine("user1", "step", "Sign In • Filling credentials");
    logger.recordApiMetric("user1", { method: "POST", path: "/api/login", status: 200, durationMs: 300 });
    logger.recordApiMetric("user1", { method: "POST", path: "/api/upload", status: 429, durationMs: 1200, errorText: "Too many requests" });
    logger.recordApiMetric("user1", { method: "GET", path: "/api/slots", status: 503, durationMs: 5100, slow: true, errorText: "Service unavailable" });
    logger.recordApiMetric("user1", { method: "GET", path: "/api/check", failed: true, durationMs: 800, errorText: "net::ERR_TIMED_OUT" });

    const metrics = logger.getMetrics("user1");
    assert.equal(metrics.totalApiCalls, 4);
    assert.equal(metrics.http429, 1);
    assert.equal(metrics.http5xx, 1);
    assert.equal(metrics.netErrors, 1);
    assert.equal(metrics.slowCalls, 1);
    assert.equal(metrics.maxLatencyMs, 5100);

    logger.endSession("user1", { state: "stopped", exitCode: 0, pages: [{ label: "Sign in" }, { label: "OTP" }] });
    await logger.flush("user1");

    const latest = await logger.readLatestLog("user1");
    assert.ok(latest, "latest session log exists on disk");
    assert.match(latest.content, /IVAC Session Log \| Account: user1/);
    assert.match(latest.content, /HTTP 429 POST \/api\/upload/);
    assert.match(latest.content, /HTTP 503 GET \/api\/slots/);
    assert.match(latest.content, /NET_FAIL GET \/api\/check/);
    assert.match(latest.content, /Session Summary \| Account: user1/);
    assert.match(latest.content, /429=1, 5xx=1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CircuitBreaker adapts stagger on degradation, opens on severe traffic spikes, and recovers", () => {
  let fakeNow = 1_000_000;
  const cb = new CircuitBreaker({
    enabled: true,
    windowMs: 60_000,
    baseCooldownMs: 30_000,
    now: () => fakeNow,
  });

  assert.equal(cb.status().state, "healthy");
  assert.equal(cb.canLaunch(), true);
  assert.equal(cb.effectiveStaggerMs(10_000), 10_000);

  // Single 429 -> degraded (2x stagger)
  cb.record({ status: 429, account: "u1" });
  assert.equal(cb.status().state, "degraded");
  assert.equal(cb.canLaunch(), true);
  assert.equal(cb.effectiveStaggerMs(10_000), 20_000);

  // Second 429 inside 60s -> circuit trips open (blocks new launches)
  fakeNow += 5_000;
  cb.record({ status: 429, account: "u2" });
  assert.equal(cb.status().state, "open");
  assert.equal(cb.canLaunch(), false);

  // After cooldown passes -> recovers to degraded
  fakeNow += 31_000;
  assert.equal(cb.canLaunch(), true);
  assert.equal(cb.status().state, "degraded");

  // Manual pause & reset
  cb.pause("testing pause");
  assert.equal(cb.canLaunch(), false);
  assert.equal(cb.status().manualPause, true);
  cb.reset();
  assert.equal(cb.canLaunch(), true);
  assert.equal(cb.status().state, "healthy");
  cb.destroy();
});

test("panel server: live settings, concurrency queue, circuit breaker pause/reset, and persistent log download", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ivac-hybrid-srv-"));
  const port = 4500 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  const credentials = path.join(dir, "credentials.json");
  const docs = path.join(dir, "doc_file");
  await writeFile(credentials, "{}\n");

  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
    env: {
      ...process.env,
      IVAC_CREDENTIALS: credentials,
      IVAC_DOC_ROOT: docs,
      IVAC_PANEL_PORT: String(port),
      IVAC_PANEL_NO_OPEN: "1",
      IVAC_RUNNER: path.join(ROOT, "test", "fixtures", "fake-runner.js"),
      IVAC_STAGGER_SECONDS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const call = (method, url, body) =>
    fetch(`${base}${url}`, {
      method,
      headers: {
        "x-ivac-panel": "1",
        ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
      },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const waitFor = async (fn, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const val = await fn();
      if (val) return val;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("Timed out");
  };

  try {
    await waitFor(() => fetch(`${base}/api/state`).then((r) => r.ok).catch(() => false));

    // Create 2 accounts
    for (const [idx, name] of ["u1", "u2"].entries()) {
      const form = new FormData();
      form.append("name", name);
      form.append("contactNumber", `0170000000${idx + 1}`);
      form.append("password", "pw123");
      form.append("files", new Blob(["%PDF-1.4 test"]), `${name}.pdf`);
      assert.equal((await call("POST", "/api/accounts", form)).status, 200);
    }

    // Configure concurrency = 1, stagger = 0
    const setRes = await call("POST", "/api/settings", {
      maxConcurrent: 1,
      staggerSeconds: 0,
      blockAssets: true,
      journalMode: "on-demand",
      circuitBreakerEnabled: true,
    });
    assert.equal(setRes.status, 200);
    assert.equal(setRes.body.settings.maxConcurrent, 1);

    // Start all -> u1 runs, u2 stays queued because maxConcurrent = 1!
    const startAll = await call("POST", "/api/start-all");
    assert.equal(startAll.status, 200);
    assert.deepEqual(startAll.body.started, ["u1", "u2"]);

    await waitFor(async () => {
      const st = await fetch(`${base}/api/state`).then((r) => r.json());
      const u1 = st.accounts.find((a) => a.name === "u1");
      const u2 = st.accounts.find((a) => a.name === "u2");
      return u1?.state === "needs-otp" && u2?.queued === true;
    });

    // Pause circuit breaker -> stopping u1 must NOT launch u2 while paused
    assert.equal((await call("POST", "/api/circuit-breaker/pause", { reason: "test hold" })).status, 200);
    assert.equal((await call("POST", "/api/accounts/u1/stop")).status, 200);
    await waitFor(async () => {
      const st = await fetch(`${base}/api/state`).then((r) => r.json());
      return !st.accounts.find((a) => a.name === "u1")?.active;
    });
    await new Promise((r) => setTimeout(r, 300));
    const whilePaused = await fetch(`${base}/api/state`).then((r) => r.json());
    assert.equal(whilePaused.circuitBreaker.state, "open");
    assert.equal(whilePaused.accounts.find((a) => a.name === "u2").queued, true, "u2 remains paused while circuit is open");

    // Reset circuit breaker -> u2 launches immediately!
    assert.equal((await call("POST", "/api/circuit-breaker/reset")).status, 200);
    await waitFor(async () => {
      const st = await fetch(`${base}/api/state`).then((r) => r.json());
      return st.accounts.find((a) => a.name === "u2")?.state === "needs-otp";
    });

    // Download persistent disk log for u1!
    const logRes = await fetch(`${base}/api/accounts/u1/logs/download`);
    assert.equal(logRes.status, 200);
    const logText = await logRes.text();
    assert.match(logText, /IVAC Session Log \| Account: u1/);
    assert.match(logText, /Session Summary \| Account: u1/);

    await call("POST", "/api/stop-all");
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Radar detects portal open -> auto-wakes Standby accounts, plus Live Peek & Focus IPC", { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ivac-radar-peek-"));
  const port = 4500 + Math.floor(Math.random() * 400);
  const base = `http://127.0.0.1:${port}`;
  const credentials = path.join(dir, "credentials.json");
  const docs = path.join(dir, "doc_file");
  const fakeRadarRunner = path.join(dir, "radar-runner.mjs");
  await writeFile(credentials, "{}\n");
  await writeFile(fakeRadarRunner, `
    const mode = process.env.IVAC_RUN_MODE || "normal";
    const send = (m) => process.send && process.send({ ...m, time: Date.now() });
    process.on("message", (msg) => {
      if (msg.type === "peek") {
        send({ type: "peek-result", id: msg.id, ok: true, image: "data:image/jpeg;base64,/9j/mock", path: "/signin", title: "IVAC Test" });
      } else if (msg.type === "focus") {
        send({ type: "log", level: "info", text: "FOCUS_RECEIVED" });
      } else if (msg.type === "go-live") {
        send({ type: "state", state: "running" });
        send({ type: "log", level: "success", text: "STANDBY_WOKE_UP" });
      } else if (msg.type === "stop") {
        process.exit(0);
      }
    });
    if (mode === "standby") {
      send({ type: "state", state: "standby" });
      send({ type: "log", level: "info", text: "STANDBY_READY" });
    } else if (mode === "radar") {
      send({ type: "state", state: "radar" });
      setTimeout(() => {
        send({ type: "portal-open", detail: "Sign-in form is open and live" });
        send({ type: "state", state: "running" });
      }, 600);
    }
    setInterval(() => {}, 10_000);
  `);

  const child = spawn(process.execPath, [path.join(ROOT, "src", "server.js")], {
    env: {
      ...process.env,
      IVAC_CREDENTIALS: credentials,
      IVAC_DOC_ROOT: docs,
      IVAC_PANEL_PORT: String(port),
      IVAC_PANEL_NO_OPEN: "1",
      IVAC_RUNNER: fakeRadarRunner,
      IVAC_STAGGER_SECONDS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const call = (method, url, body) =>
    fetch(`${base}${url}`, {
      method,
      headers: {
        "x-ivac-panel": "1",
        ...(body && !(body instanceof FormData) ? { "content-type": "application/json" } : {}),
      },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  const waitFor = async (fn, ms = 15_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const val = await fn();
      if (val) return val;
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error("Timed out");
  };

  try {
    await waitFor(() => fetch(`${base}/api/state`).then((r) => r.ok).catch(() => false));

    for (const [idx, name] of ["radar1", "sb1", "sb2"].entries()) {
      const form = new FormData();
      form.append("name", name);
      form.append("contactNumber", `0180000000${idx + 1}`);
      form.append("password", "pw123");
      form.append("files", new Blob(["%PDF-1.4 test"]), `${name}.pdf`);
      assert.equal((await call("POST", "/api/accounts", form)).status, 200);
    }

    // Assign radar1 -> radar, and click Set Others -> Standby
    assert.equal((await call("POST", "/api/accounts/radar1/role", { role: "radar" })).status, 200);
    const setStandby = await call("POST", "/api/radar/set-others-standby");
    assert.equal(setStandby.status, 200);
    assert.deepEqual(setStandby.body.updated.sort(), ["sb1", "sb2"]);

    // Start standby accounts first so we can verify Peek & Focus while in Standby!
    assert.equal((await call("POST", "/api/accounts/sb1/start")).status, 200);
    assert.equal((await call("POST", "/api/accounts/sb2/start")).status, 200);
    await waitFor(async () => {
      const st = await fetch(`${base}/api/state`).then((r) => r.json());
      return st.radar.activeStandby === 2;
    });

    // Test Live Peek screenshot on sb1
    const peek = await call("POST", "/api/accounts/sb1/peek");
    assert.equal(peek.status, 200);
    assert.equal(peek.body.image, "data:image/jpeg;base64,/9j/mock");
    assert.equal(peek.body.path, "/signin");

    // Test Focus Window on sb1
    assert.equal((await call("POST", "/api/accounts/sb1/focus")).status, 200);
    await waitFor(async () => {
      const st = await fetch(`${base}/api/state`).then((r) => r.json());
      return st.accounts.find((a) => a.name === "sb1")?.logs?.some((l) => l.text.includes("FOCUS_RECEIVED"));
    });

    // Now start radar1 -> it detects portal open after 600ms and auto-wakes sb1 & sb2!
    assert.equal((await call("POST", "/api/accounts/radar1/start")).status, 200);
    await waitFor(async () => {
      const st = await fetch(`${base}/api/state`).then((r) => r.json());
      const sb1 = st.accounts.find((a) => a.name === "sb1");
      const sb2 = st.accounts.find((a) => a.name === "sb2");
      return st.radar.status === "open"
        && st.radar.detectedBy === "radar1"
        && sb1?.logs?.some((l) => l.text.includes("STANDBY_WOKE_UP"))
        && sb2?.logs?.some((l) => l.text.includes("STANDBY_WOKE_UP"));
    });

    await call("POST", "/api/stop-all");
  } finally {
    child.kill();
    await rm(dir, { recursive: true, force: true });
  }
});
