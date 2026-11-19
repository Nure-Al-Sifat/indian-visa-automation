// Control panel server: a local web page to manage accounts (number,
// password, Webfile PDFs), start one or all bookings, pass OTPs to the
// running bookings and watch every account's live status.
//
// Only this computer can reach it (it listens on 127.0.0.1), and every
// change must come from the panel page itself (custom header + origin check),
// because the panel handles passwords.
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseAccounts, safeAccountName } from "./accounts.js";
import { BrowserPool } from "./browser-pool.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import { SessionLogger } from "./session-logger.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CREDENTIALS_PATH = process.env.IVAC_CREDENTIALS ? path.resolve(process.env.IVAC_CREDENTIALS) : path.join(PROJECT_ROOT, "credentials.json");
const DATA_DIR = process.env.IVAC_CREDENTIALS ? path.dirname(CREDENTIALS_PATH) : PROJECT_ROOT;
const DOC_ROOT = process.env.IVAC_DOC_ROOT ? path.resolve(process.env.IVAC_DOC_ROOT) : path.join(PROJECT_ROOT, "doc_file");
const LOGS_ROOT = process.env.IVAC_LOGS_ROOT ? path.resolve(process.env.IVAC_LOGS_ROOT) : path.join(DATA_DIR, "logs");
const SETTINGS_PATH = path.join(DATA_DIR, "panel-settings.json");
const CUSTOM_RUNNER = Boolean(process.env.IVAC_RUNNER);
const RUNNER_PATH = process.env.IVAC_RUNNER ? path.resolve(process.env.IVAC_RUNNER) : path.join(PROJECT_ROOT, "src", "index.js");
const PANEL_HTML = path.join(PROJECT_ROOT, "src", "panel", "index.html");
const HOST = "127.0.0.1";
const PORT = Number(process.env.IVAC_PANEL_PORT || 4370);
const DEFAULT_STAGGER_SECONDS = Math.max(0, Number(process.env.IVAC_STAGGER_SECONDS ?? 20));
const MAX_PDF_BYTES = 500 * 1024;
const MAX_LOGS = 400;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$/;
const NUMBER_PATTERN = /^01\d{9}$/;

// ---------------------------------------------------------------------------
// Hybrid System Runtime Settings, Browser Pool, Circuit Breaker & Session Logs
// ---------------------------------------------------------------------------

const VALID_ROLES = new Set(["normal", "radar", "standby"]);

const settings = {
  maxConcurrent: Math.max(1, Number(process.env.IVAC_MAX_CONCURRENT || 10)),
  staggerSeconds: DEFAULT_STAGGER_SECONDS,
  poolMode: process.env.IVAC_POOL_MODE !== "0",
  maxContextsPerBrowser: Math.max(1, Number(process.env.IVAC_MAX_CONTEXTS_PER_BROWSER || 10)),
  blockAssets: process.env.IVAC_BLOCK_ASSETS !== "0",
  journalMode: process.env.IVAC_JOURNAL_MODE === "full" ? "full" : "on-demand",
  circuitBreakerEnabled: process.env.IVAC_CIRCUIT_BREAKER !== "0",
  headless: process.env.IVAC_HEADLESS === "1",
  radarIntervalSeconds: Math.max(3, Number(process.env.IVAC_RADAR_INTERVAL_SECONDS || 10)),
  accountRoles: {},
};

const radarState = {
  status: "idle", // "idle" | "watching" | "open"
  detectedBy: null,
  detectedAt: null,
  detail: "",
};
const standbyWakeTimers = new Map();
let nextPeekId = 1;
const pendingPeeks = new Map();

function getAccountRole(name) {
  const role = settings.accountRoles?.[name];
  return VALID_ROLES.has(role) ? role : "normal";
}

function setAccountRole(name, role, { persist = true } = {}) {
  if (!VALID_ROLES.has(role)) return { ok: false, error: "Role must be normal, radar, or standby." };
  if (role === "normal") delete settings.accountRoles[name];
  else settings.accountRoles[name] = role;
  if (persist) void savePanelSettings();
  scheduleAccountBroadcast(name);
  broadcastSystemStatus();
  return { ok: true, role };
}

async function loadPanelSettings() {
  try {
    const raw = JSON.parse(await readFile(SETTINGS_PATH, "utf8"));
    applySettingsUpdate(raw, { persist: false });
  } catch {}
}

async function savePanelSettings() {
  try {
    const temp = `${SETTINGS_PATH}.tmp`;
    await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await rename(temp, SETTINGS_PATH);
  } catch {}
}

function applySettingsUpdate(patch = {}, { persist = true } = {}) {
  if (patch.maxConcurrent !== undefined) {
    settings.maxConcurrent = Math.max(1, Math.min(100, Math.round(Number(patch.maxConcurrent) || 10)));
  }
  if (patch.staggerSeconds !== undefined && !Number.isNaN(Number(patch.staggerSeconds))) {
    settings.staggerSeconds = Math.max(0, Math.min(180, Math.round(Number(patch.staggerSeconds))));
  }
  if (patch.poolMode !== undefined) settings.poolMode = Boolean(patch.poolMode);
  if (patch.maxContextsPerBrowser !== undefined) {
    settings.maxContextsPerBrowser = Math.max(1, Math.min(25, Math.round(Number(patch.maxContextsPerBrowser) || 10)));
  }
  if (patch.blockAssets !== undefined) settings.blockAssets = Boolean(patch.blockAssets);
  if (patch.journalMode === "full" || patch.journalMode === "on-demand") settings.journalMode = patch.journalMode;
  if (patch.circuitBreakerEnabled !== undefined) settings.circuitBreakerEnabled = Boolean(patch.circuitBreakerEnabled);
  if (patch.headless !== undefined) settings.headless = Boolean(patch.headless);
  if (patch.radarIntervalSeconds !== undefined && !Number.isNaN(Number(patch.radarIntervalSeconds))) {
    settings.radarIntervalSeconds = Math.max(3, Math.min(60, Math.round(Number(patch.radarIntervalSeconds))));
  }
  if (patch.accountRoles && typeof patch.accountRoles === "object" && !Array.isArray(patch.accountRoles)) {
    const clean = {};
    for (const [k, v] of Object.entries(patch.accountRoles)) {
      if (VALID_ROLES.has(v) && v !== "normal") clean[k] = v;
    }
    settings.accountRoles = clean;
  }

  browserPool.configure({
    maxContextsPerBrowser: settings.maxContextsPerBrowser,
    headless: settings.headless,
  });
  circuitBreaker.configure({ enabled: settings.circuitBreakerEnabled });
  if (persist) void savePanelSettings();
  broadcastSystemStatus();
  pumpQueue();
  return { ...settings };
}

const sessionLogger = new SessionLogger(LOGS_ROOT);
const browserPool = new BrowserPool({
  maxContextsPerBrowser: settings.maxContextsPerBrowser,
  headless: settings.headless,
  onChange: () => broadcastSystemStatus(),
});
const circuitBreaker = new CircuitBreaker({
  enabled: settings.circuitBreakerEnabled,
  onChange: () => {
    broadcastSystemStatus();
    pumpQueue();
  },
});

// ---------------------------------------------------------------------------
// Accounts on disk: credentials.json + doc_file/<name>/
// ---------------------------------------------------------------------------

async function readCredentialsJson() {
  try {
    return JSON.parse(await readFile(CREDENTIALS_PATH, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error(`credentials.json could not be read: ${error.message}`);
  }
}

async function writeCredentialsJson(json) {
  const temp = `${CREDENTIALS_PATH}.tmp`;
  await writeFile(temp, `${JSON.stringify(json, null, 2)}\n`, "utf8");
  await rename(temp, CREDENTIALS_PATH);
}

// The original single-account file is turned into a named account the first
// time the panel saves, and its PDFs move to that account's folder.
async function loadNamedAccounts() {
  const json = await readCredentialsJson();
  const parsed = parseAccounts(json);
  if (parsed.mode !== "single") {
    const named = {};
    for (const account of parsed.accounts) named[account.name] = { contactNumber: account.contactNumber, password: account.password };
    return { named, legacy: null };
  }
  return { named: {}, legacy: parsed.accounts[0] };
}

async function migrateLegacyIfNeeded() {
  const { named, legacy } = await loadNamedAccounts();
  if (!legacy) return named;
  const name = "account1";
  await writeFile(path.join(path.dirname(CREDENTIALS_PATH), "credentials.single-backup.json"), await readFile(CREDENTIALS_PATH, "utf8"), "utf8");
  const folder = path.join(DOC_ROOT, name);
  await mkdir(folder, { recursive: true });
  for (const entry of await readdir(DOC_ROOT, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && /\.pdf$/i.test(entry.name)) {
      await rename(path.join(DOC_ROOT, entry.name), path.join(folder, entry.name));
    }
  }
  const migrated = { [name]: { contactNumber: legacy.contactNumber, password: legacy.password } };
  await writeCredentialsJson(migrated);
  return migrated;
}

async function listDocs(name) {
  const folder = path.join(DOC_ROOT, safeAccountName(name));
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
  const pdfs = entries.filter((entry) => entry.isFile() && /\.pdf$/i.test(entry.name)).map((entry) => entry.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const docs = [];
  for (const [index, file] of pdfs.entries()) {
    const info = await stat(path.join(folder, file)).catch(() => null);
    docs.push({ file, sizeKB: info ? Math.ceil(info.size / 1024) : 0, primary: index === 0 });
  }
  return docs;
}

const maskNumber = (number) => (number && number.length >= 5 ? `${number.slice(0, 3)}${"•".repeat(number.length - 5)}${number.slice(-2)}` : "•••");

// ---------------------------------------------------------------------------
// Running bookings: Hybrid Pool + Concurrency Queue + Adaptive Circuit Breaker
// ---------------------------------------------------------------------------

const runners = new Map();
const launchQueue = []; // array of account names waiting to launch
let queueTimer = null;
let nextAllowedLaunchAt = 0;

function runnerFor(name) {
  if (!runners.has(name)) {
    runners.set(name, {
      name,
      child: null,
      launching: false,
      queued: false,
      browserId: null,
      state: "ready",
      startsAt: null,
      startedAt: null,
      page: null,
      pages: [],
      step: null,
      detail: "",
      lastMessage: "",
      needsOtp: false,
      otpStatus: "",
      question: null,
      logs: [],
      exitCode: null,
    });
  }
  return runners.get(name);
}

function isRunningProcess(runner) {
  return Boolean(runner.child) || Boolean(runner.launching);
}

function isActive(runner) {
  return isRunningProcess(runner) || Boolean(runner.queued);
}

function runningCount() {
  let count = 0;
  for (const r of runners.values()) if (isRunningProcess(r)) count += 1;
  return count;
}

function addLog(runner, level, text) {
  const entry = { time: Date.now(), level, text };
  runner.logs.push(entry);
  if (runner.logs.length > MAX_LOGS) runner.logs.splice(0, runner.logs.length - MAX_LOGS);
  sessionLogger.writeLine(runner.name, level, text, entry.time);
  broadcast({ type: "log", name: runner.name, entry });
  return entry;
}

function handleRunnerMessage(runner, message) {
  switch (message.type) {
    case "state":
      if (!["needs-otp", "payment", "done"].includes(runner.state) || message.state === "starting") {
        runner.state = message.state;
      }
      if (message.state === "radar" && radarState.status === "idle") {
        radarState.status = "watching";
      }
      broadcastSystemStatus();
      break;
    case "log":
      addLog(runner, message.level, message.text);
      if (message.step) {
        runner.step = message.step;
        runner.detail = message.detail || "";
      }
      if (message.level !== "journal") runner.lastMessage = message.text;
      break;
    case "peek-result": {
      const pending = pendingPeeks.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingPeeks.delete(message.id);
        pending.resolve(message);
      }
      return;
    }
    case "portal-open":
      triggerAllStandby({ source: runner.name, detail: message.detail || "Portal login/booking is open" });
      return;
    case "api-metric":
      sessionLogger.recordApiMetric(runner.name, message);
      circuitBreaker.record({
        status: message.status,
        failed: message.failed,
        slow: message.slow,
        durationMs: message.durationMs,
        account: runner.name,
        detail: `${message.method || "GET"} ${message.path || "/"}`,
      });
      break;
    case "page": {
      const previousKey = runner.page?.key;
      runner.page = { key: message.key, label: message.label, path: message.path, tab: message.tab, turnstile: message.turnstile, buttons: message.buttons, alerts: message.alerts, time: message.time };
      if (previousKey !== message.key) {
        runner.pages.push({ key: message.key, label: message.label, path: message.path, time: message.time });
        if (runner.pages.length > 30) runner.pages.shift();
      }
      if (message.key === "otp") {
        if (!runner.otpStatus || runner.otpStatus === "verified") runner.otpStatus = "waiting";
      } else if (previousKey === "otp") {
        runner.needsOtp = false;
        runner.otpStatus = "verified";
      }
      if (message.key === "payment") runner.state = "payment";
      else if (message.key === "confirmed") runner.state = "done";
      else if (runner.state === "needs-otp" && message.key !== "otp" && message.key !== "login") runner.state = "running";
      break;
    }
    case "need-otp":
      if (!runner.needsOtp) runner.otpSince = Date.now();
      runner.needsOtp = true;
      runner.otpStatus = message.rejected ? `rejected: ${message.rejected}` : "waiting";
      runner.state = "needs-otp";
      break;
    case "otp-received":
      runner.otpStatus = "received; filling it in";
      break;
    case "question":
      runner.question = { id: message.id, text: message.text };
      break;
    case "question-cancelled":
      if (runner.question?.id === message.id) runner.question = null;
      break;
    default:
      break;
  }
  scheduleAccountBroadcast(runner.name);
}

async function launchRunnerProcess(name) {
  const runner = runnerFor(name);
  if (isRunningProcess(runner)) return;
  runner.queued = false;
  runner.launching = true;
  runner.startsAt = null;
  runner.state = "starting";
  runner.startedAt = Date.now();
  runner.exitCode = null;
  runner.needsOtp = false;
  runner.otpStatus = "";
  runner.question = null;
  runner.pages = [];
  runner.page = null;
  runner.step = null;
  runner.detail = "";
  runner.browserId = null;

  const runRole = getAccountRole(name);
  const usePool = settings.poolMode && !CUSTOM_RUNNER;
  sessionLogger.startSession(name, {
    role: runRole,
    poolMode: usePool,
    blockAssets: settings.blockAssets,
    journalMode: settings.journalMode,
    headless: settings.headless,
  });

  let wsEndpoint = "";
  if (usePool) {
    addLog(runner, "info", "Acquiring isolated context from shared browser pool...");
    try {
      const slot = await browserPool.acquire(name);
      // If stop was requested while Chrome was starting, release immediately
      if (!runner.launching) {
        browserPool.release(name);
        return;
      }
      wsEndpoint = slot.wsEndpoint;
      runner.browserId = slot.browserId;
      addLog(runner, "info", `Assigned to Shared Browser #${slot.browserId} (asset blocking: ${settings.blockAssets ? "ON" : "OFF"}, journal: ${settings.journalMode}).`);
    } catch (error) {
      runner.launching = false;
      runner.state = "error";
      addLog(runner, "error", `Shared browser pool launch failed: ${error.message}`);
      sessionLogger.endSession(name, { state: "error", pages: runner.pages });
      scheduleAccountBroadcast(name);
      broadcastSystemStatus();
      pumpQueue();
      return;
    }
  } else {
    addLog(runner, "info", "Starting dedicated browser process...");
  }

  const child = spawn(process.execPath, [RUNNER_PATH], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      IVAC_USER: name,
      IVAC_DASHBOARD: "1",
      IVAC_START_DELAY_MS: "0",
      IVAC_BLOCK_ASSETS: settings.blockAssets ? "1" : "0",
      IVAC_JOURNAL_MODE: settings.journalMode,
      IVAC_HEADLESS: settings.headless ? "1" : "0",
      IVAC_RUN_MODE: runRole,
      IVAC_RADAR_INTERVAL_MS: String(settings.radarIntervalSeconds * 1000),
      ...(wsEndpoint ? { IVAC_BROWSER_WS: wsEndpoint } : {}),
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  runner.child = child;
  runner.launching = false;
  child.stdout.resume();
  child.stderr.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (line.trim()) addLog(runner, "error", line.trim());
    }
  });
  child.on("message", (message) => handleRunnerMessage(runner, message));
  child.on("exit", (code) => {
    runner.child = null;
    runner.launching = false;
    runner.exitCode = code;
    runner.question = null;
    runner.needsOtp = false;
    if (runner.browserId !== null) {
      browserPool.release(name);
      runner.browserId = null;
    }
    if (!["payment", "done"].includes(runner.state)) {
      runner.state = code === 0 || code === null ? "stopped" : "error";
    }
    addLog(runner, code ? "error" : "info", code ? `The booking process ended with code ${code}.` : "The booking process ended.");
    sessionLogger.endSession(name, { state: runner.state, exitCode: code, pages: runner.pages });
    scheduleAccountBroadcast(name);
    broadcastSystemStatus();
    pumpQueue();
  });
  scheduleAccountBroadcast(name);
  broadcastSystemStatus();
}

function scheduleQueuePump(delayMs) {
  if (queueTimer) clearTimeout(queueTimer);
  queueTimer = setTimeout(() => {
    queueTimer = null;
    pumpQueue();
  }, Math.max(50, delayMs));
}

function updateQueuedEstimates() {
  const cb = circuitBreaker.status();
  const baseMs = settings.staggerSeconds * 1000;
  const effStaggerMs = circuitBreaker.effectiveStaggerMs(baseMs);
  const now = Date.now();
  const earliest = Math.max(now, nextAllowedLaunchAt, cb.cooldownUntil || 0);
  launchQueue.forEach((name, idx) => {
    const runner = runnerFor(name);
    if (!runner.queued) return;
    if (cb.state === "open" && cb.manualPause) {
      runner.startsAt = null;
    } else if (runningCount() + idx >= settings.maxConcurrent && idx >= Math.max(0, settings.maxConcurrent - runningCount())) {
      runner.startsAt = null; // waiting on concurrency slot
    } else {
      runner.startsAt = earliest + idx * effStaggerMs;
    }
    scheduleAccountBroadcast(name);
  });
}

function pumpQueue() {
  if (!launchQueue.length) {
    if (queueTimer) {
      clearTimeout(queueTimer);
      queueTimer = null;
    }
    return;
  }

  const cb = circuitBreaker.status();
  if (!circuitBreaker.canLaunch()) {
    updateQueuedEstimates();
    if (cb.cooldownUntil && cb.cooldownUntil > Date.now()) {
      scheduleQueuePump(cb.cooldownUntil - Date.now() + 100);
    }
    return;
  }

  while (launchQueue.length > 0 && runningCount() < settings.maxConcurrent) {
    const now = Date.now();
    if (now < nextAllowedLaunchAt) {
      updateQueuedEstimates();
      scheduleQueuePump(nextAllowedLaunchAt - now + 50);
      return;
    }
    const nextName = launchQueue.shift();
    const runner = runnerFor(nextName);
    if (!runner.queued) continue;
    const effStaggerMs = circuitBreaker.effectiveStaggerMs(settings.staggerSeconds * 1000);
    nextAllowedLaunchAt = now + effStaggerMs;
    void launchRunnerProcess(nextName);
  }

  updateQueuedEstimates();
  broadcastSystemStatus();
}

function enqueueRunner(name) {
  const runner = runnerFor(name);
  if (isActive(runner)) return { ok: false, error: `${name} is already running or queued.` };
  runner.queued = true;
  runner.state = "scheduled";
  launchQueue.push(name);
  addLog(runner, "info", `Added to launch queue (max concurrent: ${settings.maxConcurrent}, base stagger: ${settings.staggerSeconds}s).`);
  scheduleAccountBroadcast(name);
  pumpQueue();
  broadcastSystemStatus();
  return { ok: true };
}

function startRunner(name, { queued = false } = {}) {
  const runner = runnerFor(name);
  if (isActive(runner)) return { ok: false, error: `${name} is already running.` };
  if (queued) return enqueueRunner(name);
  void launchRunnerProcess(name);
  return { ok: true };
}

function stopRunner(name) {
  const runner = runnerFor(name);
  if (standbyWakeTimers.has(name)) {
    clearTimeout(standbyWakeTimers.get(name));
    standbyWakeTimers.delete(name);
  }
  if (runner.queued) {
    runner.queued = false;
    runner.startsAt = null;
    runner.state = "stopped";
    const idx = launchQueue.indexOf(name);
    if (idx !== -1) launchQueue.splice(idx, 1);
    addLog(runner, "info", "Queued start cancelled.");
    scheduleAccountBroadcast(name);
    broadcastSystemStatus();
    return { ok: true };
  }
  if (runner.launching && !runner.child) {
    runner.launching = false;
    runner.state = "stopped";
    browserPool.release(name);
    addLog(runner, "warn", "Start cancelled while acquiring browser.");
    scheduleAccountBroadcast(name);
    broadcastSystemStatus();
    pumpQueue();
    return { ok: true };
  }
  if (!runner.child) return { ok: false, error: `${name} is not running.` };
  const child = runner.child;
  addLog(runner, "warn", "Stopping: closing this account's browser.");
  try {
    child.send({ type: "stop" });
  } catch {}
  setTimeout(() => {
    if (runner.child === child) child.kill();
  }, 8_000);
  return { ok: true };
}

function sendToRunner(name, message) {
  const runner = runnerFor(name);
  if (!runner.child) return { ok: false, error: `${name} is not running.` };
  try {
    runner.child.send(message);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function requestPeek(name) {
  const runner = runnerFor(name);
  if (!runner.child) return Promise.resolve({ ok: false, error: `${name} is not running.` });
  const id = nextPeekId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingPeeks.delete(id);
      resolve({ ok: false, error: `Timed out capturing screenshot for ${name}.` });
    }, 8_000);
    pendingPeeks.set(id, { resolve, timer });
    try {
      runner.child.send({ type: "peek", id });
    } catch (error) {
      clearTimeout(timer);
      pendingPeeks.delete(id);
      resolve({ ok: false, error: error.message });
    }
  });
}

function wakeStandbyRunner(name, source = "operator") {
  const runner = runnerFor(name);
  if (standbyWakeTimers.has(name)) {
    clearTimeout(standbyWakeTimers.get(name));
    standbyWakeTimers.delete(name);
  }
  if (!runner.child) return { ok: false, error: `${name} is not running.` };
  const res = sendToRunner(name, { type: "go-live", source });
  if (res.ok) {
    runner.state = "running";
    addLog(runner, "success", `Go-Live triggered by ${source} — proceeding to sign in!`);
    scheduleAccountBroadcast(name);
    broadcastSystemStatus();
  }
  return res;
}

function triggerAllStandby({ source = "operator", detail = "" } = {}) {
  radarState.status = "open";
  radarState.detectedBy = source;
  radarState.detectedAt = Date.now();
  radarState.detail = detail || `Triggered by ${source}`;

  const standbyList = [];
  for (const [name, runner] of runners.entries()) {
    if (runner.child && runner.state === "standby") {
      standbyList.push(name);
    }
  }

  const gapMs = circuitBreaker.effectiveStaggerMs(settings.staggerSeconds * 1000);
  standbyList.forEach((name, idx) => {
    const delayMs = idx * gapMs;
    if (delayMs === 0) {
      wakeStandbyRunner(name, source);
    } else {
      const runner = runnerFor(name);
      addLog(runner, "info", `Portal open detected (${source})! Waking from Standby in ${Math.round(delayMs / 1000)}s...`);
      const t = setTimeout(() => {
        standbyWakeTimers.delete(name);
        wakeStandbyRunner(name, source);
      }, delayMs);
      standbyWakeTimers.set(name, t);
    }
  });

  broadcast({ type: "portal-open", source, detail: radarState.detail, triggeredCount: standbyList.length });
  broadcastSystemStatus();
  return { ok: true, triggered: standbyList };
}

function resetRadar() {
  for (const timer of standbyWakeTimers.values()) clearTimeout(timer);
  standbyWakeTimers.clear();
  let watching = false;
  for (const runner of runners.values()) {
    if (runner.child && runner.state === "radar") watching = true;
  }
  radarState.status = watching ? "watching" : "idle";
  radarState.detectedBy = null;
  radarState.detectedAt = null;
  radarState.detail = "";
  broadcastSystemStatus();
  return getRadarSummary();
}

function getRadarSummary() {
  let activeRadar = 0;
  let activeStandby = 0;
  for (const runner of runners.values()) {
    if (runner.child && runner.state === "radar") activeRadar += 1;
    if (runner.child && runner.state === "standby") activeStandby += 1;
  }
  const status = radarState.status === "open"
    ? "open"
    : activeRadar > 0
      ? "watching"
      : "idle";
  return {
    status,
    detectedBy: radarState.detectedBy,
    detectedAt: radarState.detectedAt,
    detail: radarState.detail,
    activeRadar,
    activeStandby,
  };
}

// ---------------------------------------------------------------------------
// Live updates (Server-Sent Events)
// ---------------------------------------------------------------------------

const eventClients = new Set();
const pendingBroadcasts = new Map();
let systemBroadcastTimer = null;

function broadcast(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const client of eventClients) client.write(data);
}

function systemStatus() {
  return {
    settings: { ...settings },
    circuitBreaker: circuitBreaker.status(),
    pool: browserPool.stats(),
    radar: getRadarSummary(),
    runningCount: runningCount(),
    queuedCount: launchQueue.length,
  };
}

function broadcastSystemStatus() {
  if (systemBroadcastTimer) return;
  systemBroadcastTimer = setTimeout(() => {
    systemBroadcastTimer = null;
    broadcast({ type: "system", ...systemStatus() });
  }, 80);
}

function scheduleAccountBroadcast(name) {
  if (pendingBroadcasts.has(name)) return;
  pendingBroadcasts.set(name, setTimeout(async () => {
    pendingBroadcasts.delete(name);
    const view = await accountView(name).catch(() => null);
    if (view) broadcast({ type: "account", account: view });
  }, 120));
}

async function accountView(name, { includeLogs = false } = {}) {
  const { named } = await loadNamedAccounts();
  const login = named[name];
  const runner = runnerFor(name);
  return {
    name,
    role: getAccountRole(name),
    contact: login ? maskNumber(login.contactNumber) : "(no login)",
    hasLogin: Boolean(login),
    docs: await listDocs(name),
    state: runner.state,
    active: isActive(runner),
    queued: runner.queued,
    browserId: runner.browserId,
    startsAt: runner.startsAt,
    startedAt: runner.startedAt,
    page: runner.page,
    pages: runner.pages,
    step: runner.step,
    detail: runner.detail,
    lastMessage: runner.lastMessage,
    needsOtp: runner.needsOtp,
    // When this account started waiting for its OTP (for the panel's OTP bar).
    otpSince: runner.needsOtp ? runner.otpSince || null : null,
    otpStatus: runner.otpStatus,
    question: runner.question,
    exitCode: runner.exitCode,
    metrics: sessionLogger.getMetrics(name),
    ...(includeLogs ? { logs: runner.logs.slice(-200) } : {}),
  };
}

async function allAccountViews(options) {
  const { named, legacy } = await loadNamedAccounts();
  const names = Object.keys(named);
  return {
    accounts: await Promise.all(names.map((name) => accountView(name, options))),
    legacy: legacy ? { contact: maskNumber(legacy.contactNumber) } : null,
  };
}

// ---------------------------------------------------------------------------
// Saving an account from the panel form
// ---------------------------------------------------------------------------

function cleanPdfName(original, index) {
  const base = path.basename(String(original || `webfile-${index + 1}.pdf`))
    .replace(/\.pdf$/i, "")
    .replace(/^\s*\d{1,2}[\s._-]+/, "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
    .trim()
    .slice(0, 80) || `webfile-${index + 1}`;
  return `${String(index + 1).padStart(2, "0")} ${base}.pdf`;
}

async function saveAccount(form) {
  const name = String(form.get("name") || "").trim();
  const typedNumber = String(form.get("contactNumber") || "").replace(/\s+/g, "");
  const password = String(form.get("password") || "");
  const files = form.getAll("files").filter((file) => file && typeof file === "object" && file.size > 0);
  const docOrderRaw = form.get("docOrder");

  if (!NAME_PATTERN.test(name)) {
    return { ok: false, error: "Account name: 1-40 letters, numbers, spaces, - or _ (for example user1)." };
  }
  const named = await migrateLegacyIfNeeded();
  const existing = named[name];
  // Editing: an empty number keeps the current one.
  const contactNumber = typedNumber || existing?.contactNumber || "";
  if (!NUMBER_PATTERN.test(contactNumber)) {
    return { ok: false, error: "Contact number must be 11 digits starting with 01." };
  }
  if (!existing && !password.trim()) {
    return { ok: false, error: "Password is required for a new account." };
  }
  for (const [otherName, other] of Object.entries(named)) {
    if (otherName !== name && other.contactNumber === contactNumber) {
      return { ok: false, error: `This number is already used by ${otherName}. One portal account cannot run twice.` };
    }
  }

  const folder = path.join(DOC_ROOT, safeAccountName(name));
  const buffers = [];
  let shouldWriteDocs = false;

  if (docOrderRaw !== null && String(docOrderRaw).trim() !== "") {
    let docOrder;
    try {
      docOrder = JSON.parse(String(docOrderRaw));
    } catch {
      return { ok: false, error: "Invalid document order payload." };
    }
    if (!Array.isArray(docOrder) || docOrder.length === 0) {
      return { ok: false, error: "Add at least one Webfile PDF (the first one is the Primary applicant)." };
    }
    if (docOrder.length > 4) {
      return { ok: false, error: "At most 4 Webfiles per account (1 Primary + 3 others)." };
    }
    const previous = (await readdir(folder).catch(() => []))
      .filter((file) => /\.pdf$/i.test(file))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const unchanged = previous.length === docOrder.length && docOrder.every(
      (item, idx) => item && item.kind === "existing" && item.file === previous[idx],
    );
    if (!unchanged) {
      if (runnerFor(name).child) {
        return { ok: false, error: `${name} is running. Stop it before changing its documents.` };
      }
      for (const [index, item] of docOrder.entries()) {
        if (!item || (item.kind !== "existing" && item.kind !== "new")) {
          return { ok: false, error: "Invalid document item in upload list." };
        }
        if (item.kind === "existing") {
          const safeFile = path.basename(String(item.file || ""));
          if (!safeFile || safeFile !== item.file || !previous.includes(safeFile)) {
            return { ok: false, error: `Saved PDF "${item.file}" could not be found.` };
          }
          const buffer = await readFile(path.join(folder, safeFile));
          buffers.push({ name: cleanPdfName(safeFile, index), buffer });
        } else {
          const file = files[item.index];
          if (!file) {
            return { ok: false, error: `Uploaded file #${index + 1} is missing.` };
          }
          const buffer = Buffer.from(await file.arrayBuffer());
          if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
            return { ok: false, error: `${file.name || `File ${index + 1}`} is not a PDF.` };
          }
          if (buffer.length > MAX_PDF_BYTES) {
            return { ok: false, error: `${file.name} is ${Math.ceil(buffer.length / 1024)} KB; the portal accepts at most 500 KB.` };
          }
          buffers.push({ name: cleanPdfName(file.name, index), buffer });
        }
      }
      shouldWriteDocs = true;
    }
  } else {
    if (!existing && files.length === 0) {
      return { ok: false, error: "Add at least one Webfile PDF (the first one is the Primary applicant)." };
    }
    if (files.length > 4) {
      return { ok: false, error: "At most 4 Webfiles per account (1 Primary + 3 others)." };
    }
    for (const [index, file] of files.entries()) {
      const buffer = Buffer.from(await file.arrayBuffer());
      if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
        return { ok: false, error: `${file.name || `File ${index + 1}`} is not a PDF.` };
      }
      if (buffer.length > MAX_PDF_BYTES) {
        return { ok: false, error: `${file.name} is ${Math.ceil(buffer.length / 1024)} KB; the portal accepts at most 500 KB.` };
      }
      buffers.push({ name: cleanPdfName(file.name, index), buffer });
    }
    if (runnerFor(name).child && files.length) {
      return { ok: false, error: `${name} is running. Stop it before replacing its documents.` };
    }
    shouldWriteDocs = buffers.length > 0;
  }

  named[name] = { contactNumber, password: password.trim() ? password : existing.password };
  await writeCredentialsJson(named);

  if (shouldWriteDocs && buffers.length) {
    await mkdir(folder, { recursive: true });
    // Earlier documents are kept aside, not deleted.
    const previous = (await readdir(folder).catch(() => [])).filter((file) => /\.pdf$/i.test(file));
    if (previous.length) {
      const archive = path.join(DOC_ROOT, "_replaced", `${safeAccountName(name)}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      await mkdir(archive, { recursive: true });
      for (const file of previous) await rename(path.join(folder, file), path.join(archive, file));
    }
    for (const { name: fileName, buffer } of buffers) await writeFile(path.join(folder, fileName), buffer);
  }
  scheduleAccountBroadcast(name);
  return { ok: true, account: await accountView(name) };
}

async function removeAccount(name) {
  const named = await migrateLegacyIfNeeded();
  if (!named[name]) return { ok: false, error: `${name} does not exist.` };
  if (isActive(runnerFor(name))) return { ok: false, error: `${name} is running. Stop it first.` };
  delete named[name];
  await writeCredentialsJson(named);
  const folder = path.join(DOC_ROOT, safeAccountName(name));
  const archive = path.join(DOC_ROOT, "_removed", `${safeAccountName(name)}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(path.dirname(archive), { recursive: true });
  await rename(folder, archive).catch(() => {});
  runners.delete(name);
  broadcast({ type: "removed", name });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const allowedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);

function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new Error("Request too large.");
  }
  return raw ? JSON.parse(raw) : {};
}

async function readFormBody(req) {
  const length = Number(req.headers["content-length"] || 0);
  if (length > 4 * 1024 * 1024) throw new Error("Upload too large (4 PDFs of up to 500 KB each).");
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  const request = new Request(`http://${HOST}${req.url}`, { method: req.method, headers, body: Readable.toWeb(req), duplex: "half" });
  return request.formData();
}

async function handle(req, res) {
  // Only this computer, only through the panel's own address.
  if (!allowedHosts.has(req.headers.host || "")) {
    return sendJson(res, 403, { ok: false, error: "Open the panel at http://127.0.0.1:" + PORT });
  }
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return createReadStream(PANEL_HTML).pipe(res);
  }
  if (req.method === "GET" && url.pathname === "/api/state") {
    return sendJson(res, 200, {
      ok: true,
      staggerSeconds: settings.staggerSeconds,
      ...systemStatus(),
      ...(await allAccountViews({ includeLogs: true })),
    });
  }
  if (req.method === "GET" && url.pathname === "/api/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": connected\n\n");
    eventClients.add(res);
    const keepAlive = setInterval(() => res.write(": ping\n\n"), 20_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      eventClients.delete(res);
    });
    return undefined;
  }
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "accounts" && parts[2] && parts[3] === "logs" && parts[4] === "download") {
    const name = parts[2];
    const logData = await sessionLogger.readLatestLog(name);
    if (!logData) return sendJson(res, 404, { ok: false, error: `No saved session log found for ${name} yet.` });
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition": `attachment; filename="${safeAccountName(name)}-${logData.fileName}"`,
      "cache-control": "no-store",
    });
    return res.end(logData.content);
  }
  if (req.method === "GET" && parts[0] === "api" && parts[1] === "accounts" && parts[2] && parts[3] === "sessions") {
    const name = parts[2];
    return sendJson(res, 200, { ok: true, sessions: await sessionLogger.listSessions(name) });
  }

  // Every change must come from the panel page (blocks other websites).
  if (req.method !== "GET") {
    const origin = req.headers.origin;
    if (req.headers["x-ivac-panel"] !== "1" || (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, "")))) {
      return sendJson(res, 403, { ok: false, error: "Changes are only accepted from the control panel page." });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/settings") {
    const body = await readJsonBody(req);
    applySettingsUpdate(body, { persist: true });
    return sendJson(res, 200, { ok: true, ...systemStatus() });
  }
  if (req.method === "POST" && url.pathname === "/api/circuit-breaker/pause") {
    const body = await readJsonBody(req).catch(() => ({}));
    circuitBreaker.pause(body.reason || "Manually paused from control panel");
    return sendJson(res, 200, { ok: true, ...systemStatus() });
  }
  if (req.method === "POST" && url.pathname === "/api/circuit-breaker/reset") {
    circuitBreaker.reset();
    nextAllowedLaunchAt = 0;
    pumpQueue();
    return sendJson(res, 200, { ok: true, ...systemStatus() });
  }
  if (req.method === "POST" && url.pathname === "/api/radar/trigger") {
    const body = await readJsonBody(req).catch(() => ({}));
    const result = triggerAllStandby({ source: "operator", detail: body.detail || "Manually triggered from control panel" });
    return sendJson(res, 200, { ...result, ...systemStatus() });
  }
  if (req.method === "POST" && url.pathname === "/api/radar/reset") {
    resetRadar();
    return sendJson(res, 200, { ok: true, ...systemStatus() });
  }
  if (req.method === "POST" && url.pathname === "/api/radar/set-others-standby") {
    const { named } = await loadNamedAccounts();
    const updated = [];
    for (const name of Object.keys(named)) {
      if (getAccountRole(name) !== "radar") {
        setAccountRole(name, "standby", { persist: false });
        updated.push(name);
      }
    }
    await savePanelSettings();
    broadcastSystemStatus();
    return sendJson(res, 200, { ok: true, updated, ...systemStatus() });
  }
  if (req.method === "POST" && url.pathname === "/api/accounts") {
    const result = await saveAccount(await readFormBody(req));
    return sendJson(res, result.ok ? 200 : 400, result);
  }
  if (req.method === "POST" && url.pathname === "/api/start-all") {
    const { named } = await loadNamedAccounts();
    const started = [];
    const skipped = [];
    const rolePriority = { radar: 0, standby: 1, normal: 2 };
    const orderedNames = Object.keys(named).sort((a, b) => rolePriority[getAccountRole(a)] - rolePriority[getAccountRole(b)]);
    for (const name of orderedNames) {
      if (isActive(runnerFor(name))) {
        skipped.push(`${name} (already running)`);
        continue;
      }
      if ((await listDocs(name)).length === 0) {
        skipped.push(`${name} (no PDFs)`);
        continue;
      }
      startRunner(name, { queued: true });
      started.push(name);
    }
    return sendJson(res, 200, { ok: true, started, skipped, ...systemStatus() });
  }
  if (req.method === "POST" && url.pathname === "/api/stop-all") {
    for (const [name, runner] of runners) if (isActive(runner)) stopRunner(name);
    return sendJson(res, 200, { ok: true, ...systemStatus() });
  }
  if (parts[0] === "api" && parts[1] === "accounts" && parts[2]) {
    const name = parts[2];
    const { named } = await loadNamedAccounts();
    if (!named[name]) return sendJson(res, 404, { ok: false, error: `${name} does not exist.` });
    const action = parts[3];
    if (req.method === "DELETE" && !action) return sendJson(res, 200, await removeAccount(name));
    if (req.method === "POST" && action === "start") {
      if ((await listDocs(name)).length === 0) return sendJson(res, 400, { ok: false, error: `${name} has no Webfile PDFs.` });
      return sendJson(res, 200, startRunner(name));
    }
    if (req.method === "POST" && action === "stop") return sendJson(res, 200, stopRunner(name));
    if (req.method === "POST" && (action === "resume" || action === "reload")) return sendJson(res, 200, sendToRunner(name, { type: action }));
    if (req.method === "POST" && action === "focus") return sendJson(res, 200, sendToRunner(name, { type: "focus" }));
    if (req.method === "POST" && action === "peek") {
      const result = await requestPeek(name);
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    if (req.method === "POST" && action === "go-live") {
      const result = wakeStandbyRunner(name, "operator");
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    if (req.method === "POST" && action === "role") {
      const { role } = await readJsonBody(req);
      const result = setAccountRole(name, String(role || "normal").trim().toLowerCase());
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    if (req.method === "POST" && action === "otp") {
      const { code } = await readJsonBody(req);
      const digits = String(code || "").replace(/\D/g, "");
      if (digits.length < 4 || digits.length > 8) return sendJson(res, 400, { ok: false, error: "Enter the OTP digits (usually 6)." });
      const result = sendToRunner(name, { type: "otp", code: digits });
      if (result.ok) {
        const runner = runnerFor(name);
        runner.otpStatus = "sent from panel";
        addLog(runner, "info", "OTP sent from the control panel.");
        scheduleAccountBroadcast(name);
      }
      return sendJson(res, result.ok ? 200 : 400, result);
    }
    if (req.method === "POST" && action === "answer") {
      const { id, text } = await readJsonBody(req);
      const runner = runnerFor(name);
      const result = sendToRunner(name, { type: "answer", id, text: String(text ?? "") });
      if (result.ok && runner.question?.id === id) {
        addLog(runner, "info", `Answered "${runner.question.text}" with "${String(text ?? "")}".`);
        runner.question = null;
        scheduleAccountBroadcast(name);
      }
      return sendJson(res, result.ok ? 200 : 400, result);
    }
  }
  return sendJson(res, 404, { ok: false, error: "Not found." });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: error.message });
    else res.end();
  });
});

await loadPanelSettings();

server.listen(PORT, HOST, () => {
  const address = `http://${HOST}:${PORT}`;
  console.log(`IVAC control panel (Hybrid System): ${address}  (only reachable from this computer)`);
  console.log("Keep this window open while bookings run. Press Ctrl+C to stop the panel and all bookings.");
  if (!process.env.IVAC_PANEL_NO_OPEN) {
    if (process.platform === "win32") spawn("cmd.exe", ["/c", "start", "", address], { detached: true, stdio: "ignore" }).unref();
    else if (process.platform === "darwin") spawn("open", [address], { detached: true, stdio: "ignore" }).unref();
  }
});

function shutdown() {
  circuitBreaker.destroy();
  if (queueTimer) clearTimeout(queueTimer);
  for (const [name, runner] of runners) if (isActive(runner)) stopRunner(name);
  void browserPool.closeAll().finally(() => {
    setTimeout(() => process.exit(0), 1_500);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
