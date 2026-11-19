import { access, readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { chromium } from "patchright";
import { fileURLToPath } from "node:url";
import { watch as watchSourceFolder } from "node:fs";
import * as initialBooking from "./booking.js";

// The booking code can be reloaded while the browser (and its login) stays
// open: the portal logs out when the browser restarts and limits new sign-ins.
let booking = initialBooking;
const BOOKING_MODULE_URL = new URL("./booking.js", import.meta.url);
async function reloadBookingCode() {
  booking = await import(`${BOOKING_MODULE_URL.href}?v=${Date.now()}`);
}
import { log } from "./logger.js";
import { captureErrorSnapshot, startPageJournal } from "./journal.js";
import { detectServerTrouble, gotoWithRecovery } from "./resilience.js";
import { parseAccounts, planAccountRuns, safeAccountName } from "./accounts.js";
import {
  LIGHTWEIGHT_CHROME_ARGS,
  installLightweightRouting,
  loadExistingSessionPath,
  saveContextSession,
} from "./browser-pool.js";
import { spawn } from "node:child_process";
import {
  PANEL_MODE,
  createPanelPrompts,
  forwardConsoleToPanel,
  nextPanelCommand,
  onPanelFocus,
  onPanelPeek,
  onPanelStop,
  panelOtp,
  sendToPanel,
  waitForGoLive,
} from "./panel-bridge.js";
import {
  fillLabeledFields,
  getAvailabilityState,
  getPortalIssues,
  getPortalStep,
} from "./assistant.js";

const PORTAL_URL = "https://appointment.ivacbd.com/";
const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PROFILE_PATH = path.join(PROJECT_ROOT, "profile.json");
const CREDENTIALS_PATH = process.env.IVAC_CREDENTIALS
  ? path.resolve(process.env.IVAC_CREDENTIALS)
  : path.join(PROJECT_ROOT, "credentials.json");
const DOC_ROOT = process.env.IVAC_DOC_ROOT
  ? path.resolve(process.env.IVAC_DOC_ROOT)
  : path.join(PROJECT_ROOT, "doc_file");
const SESSIONS_ROOT = process.env.IVAC_SESSIONS_ROOT
  ? path.resolve(process.env.IVAC_SESSIONS_ROOT)
  : path.join(PROJECT_ROOT, "sessions");
// Set by the multi-account launcher for each account's own window.
const ACTIVE_USER = (process.env.IVAC_USER || "").trim() || null;
// Every account gets its own browser profile, so logins never mix.
const BROWSER_DATA_PATH = ACTIVE_USER
  ? path.join(PROJECT_ROOT, "user-data", safeAccountName(ACTIVE_USER))
  : path.join(PROJECT_ROOT, "user-data");
const CHECK_INTERVAL_MS = 15_000;
// Seconds between account windows, so the portal does not see many sign-ins
// at once (it answers too many sign-ins with HTTP 429).
const STAGGER_MS =
  Math.max(0, Number(process.env.IVAC_STAGGER_SECONDS ?? 20)) * 1000;

async function loadProfile() {
  try {
    await access(PROFILE_PATH);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(
        "No profile.json found. Copy profile.example.json to profile.json to enable optional autofill.",
      );
      return null;
    }
    throw error;
  }

  const profile = JSON.parse(await readFile(PROFILE_PATH, "utf8"));
  if (!profile || Array.isArray(profile) || typeof profile !== "object") {
    throw new Error(
      "profile.json must contain a JSON object mapping visible field labels to string values.",
    );
  }
  return profile;
}

async function loadAccountConfig() {
  try {
    await access(CREDENTIALS_PATH);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(
        "No credentials.json found. Add contactNumber and password to enable automatic sign-in.",
      );
      return { mode: "none", accounts: [], problems: [] };
    }
    throw error;
  }
  return parseAccounts(JSON.parse(await readFile(CREDENTIALS_PATH, "utf8")));
}

// Opens one independent window (own console, own browser, own login) per
// account, a few seconds apart.
function openAccountWindow(account, startDelayMs) {
  const env = {
    ...process.env,
    IVAC_USER: account.name,
    IVAC_START_DELAY_MS: String(startDelayMs),
  };
  if (process.env.IVAC_LAUNCH_DRY_RUN) {
    log.info(`[dry run] would open a window for ${account.name}`);
    return;
  }
  if (process.platform === "win32") {
    const title = `IVAC ${safeAccountName(account.name)}`.replace(
      /["^&|<>]/g,
      "",
    );
    const command = `start "${title}" /D "${PROJECT_ROOT}" cmd /k node src\\index.js`;
    spawn("cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
      env,
      cwd: PROJECT_ROOT,
      detached: true,
      stdio: "ignore",
      windowsVerbatimArguments: true,
    }).unref();
    return;
  }
  // Other systems: run in the background and prefix each line with the account.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env,
    cwd: PROJECT_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prefix = (stream) =>
    stream.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/))
        if (line.trim()) console.log(`[${account.name}] ${line}`);
    });
  prefix(child.stdout);
  prefix(child.stderr);
}

async function launchAccounts(accounts) {
  log.banner("IVAC VISA BOOKING AUTOMATION", "Multi-account launcher");
  const { ready, notes } = await planAccountRuns(accounts, DOC_ROOT);
  for (const note of notes) log.warn(note);
  if (ready.length === 0) {
    log.error(
      "No account is ready. Put each account's PDFs in doc_file/<name>/ using the names from credentials.json.",
    );
    return;
  }
  log.info(
    `${ready.length} account(s) ready; opening one independent browser window for each.`,
  );
  ready.forEach((account, index) => {
    const delay = index * STAGGER_MS;
    log.item(
      account.name,
      `${account.pdfs.length} PDF(s) in doc_file/${safeAccountName(account.name)} • number ending ${account.contactNumber.slice(-2)} • starts ${delay ? `after ${delay / 1000}s` : "now"}`,
    );
    openAccountWindow(account, delay);
  });
  log.success(
    "All account windows were opened. Each one signs in on its own; enter each OTP in that account's browser.",
  );
}

async function readPageText(page) {
  if (page.isClosed()) {
    return "";
  }
  return page.locator("body").innerText({ timeout: 5_000 });
}

function redactSensitiveText(value, credentials) {
  let text = String(value ?? "");
  for (const secret of [credentials?.password, credentials?.contactNumber]) {
    if (typeof secret === "string" && secret.length > 0) {
      text = text.split(secret).join("[redacted]");
    }
  }
  text = text.replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
    try {
      return new URL(value).origin;
    } catch {
      return "[redacted URL]";
    }
  });
  return text;
}

function safeUrlForLog(value, credentials) {
  try {
    const cleanValue = String(value || "").replace(/:\d+:\d+$/, "");
    const url = new URL(cleanValue);
    return redactSensitiveText(url.origin, credentials);
  } catch {
    return "unknown location";
  }
}

function safePathForLog(value, credentials) {
  try {
    const url = new URL(String(value || ""));
    const cleanPath = (url.pathname || "/").replace(/\d{6,}/g, "[digits]");
    return redactSensitiveText(cleanPath, credentials);
  } catch {
    return "/";
  }
}

const API_MONITOR_IGNORED_TYPES = new Set(["image", "font", "stylesheet", "media"]);
const API_MONITOR_IGNORED_URLS = /analytics|gtag|doubleclick|clarity|hotjar|google|challenges\.cloudflare\.com|cloudflareinsights/i;
const SLOW_API_MS = 4_000;

function extractSafeErrorSnippet(rawText, credentials) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    const msg = parsed?.message || parsed?.error || parsed?.detail || parsed?.msg || "";
    if (typeof msg === "string" && msg.trim()) {
      return redactSensitiveText(msg.replace(/\s+/g, " ").trim().slice(0, 140), credentials);
    }
  } catch {}
  if (/^<!doctype|^<html/i.test(trimmed)) {
    const title = trimmed.match(/<title[^>]*>([^<]{1,100})<\/title>/i)?.[1]?.trim();
    return title ? redactSensitiveText(title, credentials) : "";
  }
  return redactSensitiveText(trimmed.replace(/\s+/g, " ").slice(0, 140), credentials);
}

function installBrowserErrorReporting(page, credentials) {
  const requestStartTimes = new WeakMap();
  let lastSnapshotAt = 0;
  const maybeSnapshot = (reason) => {
    const now = Date.now();
    if (now - lastSnapshotAt < 15_000) return;
    lastSnapshotAt = now;
    void captureErrorSnapshot(page, reason);
  };

  page.on("request", (request) => {
    const type = request.resourceType();
    if (API_MONITOR_IGNORED_TYPES.has(type)) return;
    requestStartTimes.set(request, Date.now());
  });

  page.on("console", (message) => {
    if (message.type() !== "error") {
      return;
    }
    const text = message.text();
    // Filter non-essential tracking / font / analytics errors
    // Also skip the Cloudflare challenge widget's own Content Security Policy noise.
    if (
      /analytics|gtag|doubleclick|clarity|hotjar|favicon|fonts\.gstatic|Content Security Policy|cannot load data:,|challenges\.cloudflare/i.test(
        text,
      )
    ) {
      return;
    }
    log.warn(`Browser console: ${redactSensitiveText(text, credentials)}`);
  });

  page.on("pageerror", (error) => {
    const msg = error.message || "";
    if (/ResizeObserver|Non-Error promise rejection/i.test(msg)) {
      return;
    }
    log.error(`Browser script error: ${redactSensitiveText(msg, credentials)}`);
  });

  page.on("response", async (response) => {
    const request = response.request();
    const url = response.url();
    const resourceType = request.resourceType();
    if (API_MONITOR_IGNORED_TYPES.has(resourceType)) return;
    if (API_MONITOR_IGNORED_URLS.test(url)) return;
    if (!["xhr", "fetch", "document"].includes(resourceType)) return;

    const status = response.status();
    const started = requestStartTimes.get(request);
    const durationMs = started ? Math.max(0, Date.now() - started) : 0;
    const reqPath = safePathForLog(url, credentials);
    const method = request.method();

    if (status >= 400) {
      let snippet = "";
      try {
        const ct = response.headers()["content-type"] || "";
        if (/json|text|html/i.test(ct)) {
          snippet = extractSafeErrorSnippet(await response.text(), credentials);
        }
      } catch {}
      const msg = `API Error: ${method} ${reqPath} → HTTP ${status} (${durationMs}ms)${snippet ? ` — "${snippet}"` : ""}`;
      if (status === 429 || status >= 500) {
        log.error(msg);
        maybeSnapshot(`http-${status}`);
      } else {
        log.warn(msg);
      }
      sendToPanel({
        type: "api-metric",
        method,
        path: reqPath,
        status,
        durationMs,
        errorText: snippet,
      });
      return;
    }

    const slow = durationMs >= SLOW_API_MS;
    if (slow) {
      log.warn(`Slow API: ${method} ${reqPath} → HTTP ${status} (${durationMs}ms)`);
    }
    sendToPanel({
      type: "api-metric",
      method,
      path: reqPath,
      status,
      durationMs,
      slow,
    });
  });

  page.on("requestfailed", (request) => {
    const url = request.url();
    const resourceType = request.resourceType();
    if (API_MONITOR_IGNORED_TYPES.has(resourceType)) {
      return;
    }
    if (API_MONITOR_IGNORED_URLS.test(url)) {
      return;
    }
    const failure = request.failure();
    if (failure?.errorText === "net::ERR_ABORTED") {
      return;
    }
    const started = requestStartTimes.get(request);
    const durationMs = started ? Math.max(0, Date.now() - started) : 0;
    const reqPath = safePathForLog(url, credentials);
    log.warn(
      `Request failed: ${request.method()} ${safeUrlForLog(url, credentials)}${reqPath} (${failure?.errorText || "unknown"}, ${durationMs}ms)`,
    );
    sendToPanel({
      type: "api-metric",
      failed: true,
      method: request.method(),
      path: reqPath,
      durationMs,
      errorText: failure?.errorText || "unknown",
    });
    maybeSnapshot("net-fail");
  });
}

function printPageStatus(pageText, current, previous) {
  const availability = getAvailabilityState(pageText);

  if (current.key !== previous.step) {
    const guidance =
      current.key === "unknown" ? getPortalStep(pageText).guidance : "";
    log.step(`Current Page: ${current.label}`, guidance);
    previous.step = current.key;
  }

  if (availability === "possible" && previous.availability !== "possible") {
    log.success("Possible appointment availability detected on page.");
  } else if (
    availability === "unavailable" &&
    previous.availability !== "unavailable"
  ) {
    log.info("Page indicates no slot is currently available.");
  }
  previous.availability = availability;
}

// Watches every tab of the browser. Calls onEnterBookingPage(page, current) when
// a tab moves onto a page where the booking can continue (mission, waiting
// room, date picker, declaration). The page a tab was on when watching started
// (initialKeys) does not count, so a flow that stopped on the date picker is
// not restarted in a loop.
function startPortalWatcher(
  context,
  { initialKeys = new Map(), onEnterBookingPage = () => {} } = {},
) {
  const states = new Map();
  const stateFor = (page) => {
    if (!states.has(page)) {
      states.set(page, {
        step: initialKeys.get(page) ?? null,
        availability: null,
        checking: false,
        timer: null,
      });
    }
    return states.get(page);
  };
  const tabName = (page) => {
    const pages = context.pages();
    return pages.length > 1 ? ` (tab ${pages.indexOf(page) + 1})` : "";
  };

  const checkPage = async (page) => {
    const previous = stateFor(page);
    if (previous.checking || page.isClosed()) {
      return;
    }
    previous.checking = true;
    let timeoutId;
    try {
      // A page check must never block the watcher for good (for example while
      // the page is mid-navigation), so each check gets a time limit.
      const current = await Promise.race([
        (async () => {
          await booking.dismissPortalNotices(page);
          return booking.detectPortalPage(page);
        })(),
        new Promise((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error("page check timed out; retrying")),
            20_000,
          );
        }),
      ]);
      const changed = current.key !== previous.step;
      // Seen live: the OTP can take longer than the flow's sign-in wait. When a
      // tab moves from Sign in / OTP to a logged-in page, continue from there.
      const cameFromLogin =
        previous.step === "login" || previous.step === "otp";
      const loggedInNow =
        cameFromLogin &&
        changed &&
        (["booking-guide", "webfile"].includes(current.key) ||
          (current.key === "dashboard" &&
            (await booking.isAlreadyLoggedIn(page).catch(() => false))));
      // The portal's login can expire mid-booking (the browser lands on Sign
      // in). Start the flow again: it signs in and continues from the step the
      // portal saved. At most once every 3 minutes, so a failing sign-in is
      // not repeated in a loop.
      const wasLoggedIn = [
        "dashboard",
        "booking-guide",
        "webfile",
        "mission",
        "waiting",
        "time-slot",
        "declaration",
        "payment",
      ].includes(previous.step);
      const sessionExpired =
        changed &&
        wasLoggedIn &&
        current.key === "login" &&
        Date.now() - (previous.lastRelogin || 0) >= 3 * 60_000;
      printPageStatus(
        await readPageText(page).catch(() => ""),
        { ...current, label: `${current.label}${tabName(page)}` },
        previous,
      );
      previous.step = current.key;
      if (
        (changed && booking.isAutoResumePage(current.key)) ||
        loggedInNow ||
        sessionExpired
      ) {
        if (loggedInNow)
          log.success(
            "Sign-in completed in the browser; continuing the booking.",
          );
        if (sessionExpired) {
          previous.lastRelogin = Date.now();
          log.warn(
            "The portal logged out (session expired). Signing in again and continuing from the saved step.",
          );
        }
        onEnterBookingPage(page, current);
      }
    } catch (error) {
      if (!page.isClosed()) {
        log.warn(`Portal page check failed: ${error.message}`);
      }
    } finally {
      clearTimeout(timeoutId);
      previous.checking = false;
    }
  };
  const checkAll = () => {
    for (const page of context.pages()) {
      void checkPage(page);
    }
  };

  // The portal is a single-page app: check soon after every route change
  // instead of waiting for the next 15-second tick.
  const listeners = new Map();
  const attach = (page) => {
    if (listeners.has(page)) return;
    const onNavigated = (frame) => {
      if (frame !== page.mainFrame()) return;
      const state = stateFor(page);
      clearTimeout(state.timer);
      state.timer = setTimeout(() => checkPage(page), 1_500);
    };
    listeners.set(page, onNavigated);
    page.on("framenavigated", onNavigated);
  };
  context.pages().forEach(attach);
  context.on("page", attach);

  log.info(
    "Watching all browser tabs: the booking continues automatically when a tab opens the Mission, waiting room, date picker or declaration page.",
  );
  checkAll();
  const timer = setInterval(checkAll, CHECK_INTERVAL_MS);
  return () => {
    clearInterval(timer);
    for (const state of states.values()) clearTimeout(state.timer);
    for (const [page, onNavigated] of listeners)
      page.off("framenavigated", onNavigated);
    context.off("page", attach);
  };
}

const FLOW_OPTIONS = {
  autoUseDocFolder: true,
  autoConfirmApplicants: true,
  // A named account uploads its own folder: doc_file/<name>/.
  ...(ACTIVE_USER
    ? { docFolder: path.join(DOC_ROOT, safeAccountName(ACTIVE_USER)) }
    : {}),
};

async function runFlowSafely(page, prompts, credentials) {
  try {
    await booking.runGuidedBookingFlow(
      page,
      prompts,
      credentials,
      FLOW_OPTIONS,
    );
  } catch (error) {
    log.error("Guided booking stopped: " + error.message);
  }
}

async function main() {
  // Started from the control panel: send every line and status there.
  forwardConsoleToPanel();
  sendToPanel({ type: "state", state: "starting" });
  const config = await loadAccountConfig();
  for (const problem of config.problems) log.warn(problem);

  // Several accounts and no account chosen: open one window per account.
  if (config.mode === "multi" && !ACTIVE_USER) {
    await launchAccounts(config.accounts);
    return;
  }

  let credentials = null;
  if (config.mode === "single") {
    credentials = config.accounts[0];
  } else if (config.mode === "multi") {
    credentials =
      config.accounts.find((account) => account.name === ACTIVE_USER) || null;
    if (!credentials) {
      throw new Error(`No login for "${ACTIVE_USER}" in credentials.json.`);
    }
  }
  if (ACTIVE_USER) {
    process.stdout.write(`\x1b]0;IVAC ${safeAccountName(ACTIVE_USER)}\x07`);
    const startDelay = Math.max(
      0,
      Number(process.env.IVAC_START_DELAY_MS || 0),
    );
    if (startDelay) {
      log.info(
        `${ACTIVE_USER}: starting in ${Math.round(startDelay / 1000)}s so the accounts do not all sign in at once.`,
      );
      await new Promise((resolve) => setTimeout(resolve, startDelay));
    }
  }

  const pooledWs = (process.env.IVAC_BROWSER_WS || "").trim();
  const blockAssets = process.env.IVAC_BLOCK_ASSETS !== "0";
  const journalMode = process.env.IVAC_JOURNAL_MODE || "on-demand";
  let pooledBrowser = null;
  let context;

  if (pooledWs) {
    pooledBrowser = await chromium.connect(pooledWs);
    const sessionPath = ACTIVE_USER
      ? await loadExistingSessionPath(SESSIONS_ROOT, ACTIVE_USER)
      : undefined;
    context = await pooledBrowser.newContext({
      viewport: null,
      ...(sessionPath ? { storageState: sessionPath } : {}),
    });
    log.info(
      `Connected to shared browser pool (isolated context${sessionPath ? ", restored saved session" : ""}).`,
    );
  } else {
    const headless = process.env.IVAC_HEADLESS === "1";
    context = await chromium.launchPersistentContext(BROWSER_DATA_PATH, {
      channel: "chrome",
      headless,
      viewport: null,
      args: [
        ...LIGHTWEIGHT_CHROME_ARGS,
        ...(headless ? ["--window-size=1280,800"] : []),
      ],
    });
  }

  const assetRouter = await installLightweightRouting(context, { blockAssets });
  if (blockAssets) {
    log.info("Lightweight asset blocking enabled (images, fonts, media & trackers skipped).");
  }

  // Label every portal page with the account it belongs to and the number the
  // OTP SMS goes to, so with several browsers open it is clear which phone to
  // check. The label ignores the mouse and never covers the portal's controls.
  if (credentials) {
    const number = String(credentials.contactNumber || "");
    await context.addInitScript(({ account, maskedNumber }) => {
      const prefix = `[${account}] `;
      const keepTitle = () => {
        if (document.title && !document.title.startsWith(prefix)) document.title = prefix + document.title.replace(/^\[[^\]]*\]\s*/, "");
      };
      const addLabel = () => {
        if (!document.documentElement || document.getElementById("ivac-account-label")) return;
        const label = document.createElement("div");
        label.id = "ivac-account-label";
        label.textContent = `${account} • OTP goes to ${maskedNumber}`;
        label.setAttribute("aria-hidden", "true");
        label.style.cssText = [
          "position:fixed", "left:12px", "bottom:12px", "z-index:2147483647", "pointer-events:none",
          "background:#14202b", "color:#fff", "font:600 15px/1.2 system-ui,Segoe UI,sans-serif",
          "padding:8px 14px", "border-radius:999px", "box-shadow:0 2px 10px rgba(0,0,0,.35)",
          "border:2px solid #ff671f", "letter-spacing:.01em",
        ].join(";");
        document.documentElement.appendChild(label);
      };
      const refresh = () => { keepTitle(); addLabel(); };
      new MutationObserver(refresh).observe(document, { childList: true, subtree: true, characterData: true });
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", refresh);
      refresh();
    }, {
      account: ACTIVE_USER || "account",
      maskedNumber: number.length >= 5 ? `${number.slice(0, 3)}${"•".repeat(number.length - 5)}${number.slice(-2)}` : "•••",
    });
  }

  await context.addInitScript(() => {
    const unblock = () => {
      const allow = (e) => e.stopImmediatePropagation();
      ["copy", "cut", "paste", "contextmenu"].forEach((eventType) => {
        document.addEventListener(eventType, allow, true);
        window.addEventListener(eventType, allow, true);
      });
      document.oncontextmenu = null;
      document.onpaste = null;
      document.oncopy = null;
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", unblock);
    } else {
      unblock();
    }
  });

  const page = context.pages()[0] || (await context.newPage());
  let lastSessionSaveAt = 0;
  const persistSessionIfPooled = () => {
    if (!pooledBrowser || !ACTIVE_USER) return;
    const now = Date.now();
    if (now - lastSessionSaveAt < 10_000) return;
    lastSessionSaveAt = now;
    void saveContextSession(context, SESSIONS_ROOT, ACTIVE_USER);
  };
  const stopJournal = startPageJournal(context, {
    mode: journalMode,
    onPage: (entry) => {
      persistSessionIfPooled();
      sendToPanel({
        type: "page",
        tab: entry.tab,
        path: entry.path,
        key: entry.page.key,
        label: entry.page.label,
        turnstile: entry.turnstile,
        buttons: entry.buttons
          .filter((button) => button.visible && !button.disabled)
          .map((button) => button.text)
          .slice(0, 8),
        alerts: entry.alerts,
      });
    },
  });
  installBrowserErrorReporting(page, credentials);
  context.on("page", (newPage) => {
    installBrowserErrorReporting(newPage, credentials);
  });

  const getLatestOpenPage = () => {
    const open = context.pages().filter((candidate) => !candidate.isClosed());
    return open[open.length - 1] || page;
  };

  onPanelPeek(async () => {
    const target = getLatestOpenPage();
    if (!target || target.isClosed()) {
      throw new Error("No open browser page available.");
    }
    const buf = await target.screenshot({ type: "jpeg", quality: 65, timeout: 6_000 });
    return {
      image: `data:image/jpeg;base64,${buf.toString("base64")}`,
      path: safePathForLog(target.url(), credentials),
      title: await target.title().catch(() => ""),
      time: Date.now(),
    };
  });

  onPanelFocus(async () => {
    const target = getLatestOpenPage();
    if (target && !target.isClosed()) {
      await target.bringToFront();
    }
  });

  let stopWatching = () => {};
  let stopSourceWatch = () => {};
  const stopController = new AbortController();
  // In the panel, questions are answered there and the OTP typed there is
  // filled into the portal; in a terminal they use the keyboard as before.
  const prompts = PANEL_MODE
    ? createPanelPrompts()
    : readline.createInterface({ input: stdin, output: stdout });
  booking.setOtpProvider?.(PANEL_MODE ? panelOtp : null);
  onPanelStop(() => {
    log.warn(
      "Stop requested from the control panel; closing this account's browser.",
    );
    stopController.abort();
    context.close().catch(() => {});
  });

  const runMode = (process.env.IVAC_RUN_MODE || "normal").trim().toLowerCase();
  const radarIntervalMs = Math.max(3_000, Number(process.env.IVAC_RADAR_INTERVAL_MS || 10_000));

  async function checkPortalOpenForLogin(targetPage) {
    if (targetPage.isClosed()) return { open: false, reason: "Page closed" };
    const trouble = await detectServerTrouble(targetPage);
    if (trouble) return { open: false, reason: `${trouble.label}${trouble.text ? `: ${trouble.text}` : ""}` };

    await booking.dismissPortalNotices(targetPage).catch(() => {});
    const detected = await booking.detectPortalPage(targetPage).catch(() => ({ key: "unknown", label: "Unknown" }));
    if (["otp", "booking-guide", "webfile", "mission", "waiting", "time-slot", "declaration", "payment"].includes(detected.key)) {
      return { open: true, detail: `Portal live on ${detected.label}` };
    }
    const passwordInput = targetPage.locator('input[type="password"]').first();
    if (await passwordInput.isVisible().catch(() => false)) {
      return { open: true, detail: "Sign-in form is open and live" };
    }

    // If on the landing page, try clicking "Take Your Appointment" / "Book Your Appointment"
    // to verify whether the portal actually opens the Sign-In or Booking page.
    const entryBtn = targetPage
      .locator('a, button, [role="button"]')
      .filter({ hasText: /take your appointment|book your appointment|sign in/i })
      .first();
    if (await entryBtn.isVisible().catch(() => false) && await entryBtn.isEnabled().catch(() => false)) {
      await entryBtn.click({ timeout: 5_000 }).catch(() => {});
      await targetPage.waitForTimeout(1_800).catch(() => {});
      await booking.dismissPortalNotices(targetPage).catch(() => {});
      const afterTrouble = await detectServerTrouble(targetPage);
      if (afterTrouble) {
        return { open: false, reason: afterTrouble.label };
      }
      if (await targetPage.locator('input[type="password"]').first().isVisible().catch(() => false)) {
        return { open: true, detail: "Sign-in option opened after clicking Take Your Appointment" };
      }
      const afterDetected = await booking.detectPortalPage(targetPage).catch(() => ({ key: "unknown", label: "Unknown" }));
      if (["login", "otp", "booking-guide", "webfile", "mission", "waiting", "time-slot", "declaration", "payment"].includes(afterDetected.key)) {
        return { open: true, detail: `Booking entry opened (${afterDetected.label})` };
      }
      const text = await readPageText(targetPage).catch(() => "");
      if (/closed|not available|maintenance|try again later|no slot|unavailable/i.test(text)) {
        return { open: false, reason: "Portal shows closed / unavailable notice" };
      }
    }
    return { open: false, reason: "Sign-in / appointment entry not open yet" };
  }

  sendToPanel({ type: "state", state: runMode === "radar" ? "radar" : "running" });

  try {
    log.banner(
      "IVAC VISA BOOKING AUTOMATION",
      ACTIVE_USER
        ? `Account: ${ACTIVE_USER} (${runMode.toUpperCase()}) • Stops Safely at Payment Step`
        : "Guided Flow • Stops Safely at Payment Step",
    );
    if (ACTIVE_USER) {
      log.info(
        `Account ${ACTIVE_USER}: mode=${runMode}, documents from doc_file/${safeAccountName(ACTIVE_USER)}.`,
      );
    }
    log.info(`Connecting to IVAC portal (${PORTAL_URL})...`);
    // Under heavy load the first page may time out or show an error page.
    if (!(await gotoWithRecovery(page, PORTAL_URL))) {
      log.warn(
        "The portal did not open properly; continuing with whatever the browser shows.",
      );
    }
    await page.waitForTimeout(500);
    await booking.dismissPortalNotices(page);

    if (credentials) {
      log.success("Sign-in credentials loaded from credentials.json");
    } else {
      log.info("Manual sign-in mode (credentials.json not found)");
    }

    if (runMode === "standby") {
      sendToPanel({ type: "state", state: "standby" });
      log.step("Standby", "Browser is open on portal — waiting quietly for Radar signal (no login attempts yet)");
      try {
        await waitForGoLive(stopController.signal);
      } catch (err) {
        if (err.name === "AbortError") return;
        throw err;
      }
      if (page.isClosed()) return;
      sendToPanel({ type: "state", state: "running" });
      log.success("Go-Live signal received! Starting login & booking flow now...");
      if (await detectServerTrouble(page)) {
        await gotoWithRecovery(page, PORTAL_URL);
        await booking.dismissPortalNotices(page);
      }
    } else if (runMode === "radar") {
      sendToPanel({ type: "state", state: "radar" });
      log.step("Radar", `Monitoring portal every ${Math.round(radarIntervalMs / 1000)}s for login/booking opening...`);
      let attempt = 0;
      while (!page.isClosed() && !stopController.signal.aborted) {
        attempt += 1;
        const check = await checkPortalOpenForLogin(page);
        if (check.open) {
          log.success(`RADAR ALERT: ${check.detail}! Triggering all Standby accounts...`);
          sendToPanel({ type: "portal-open", detail: check.detail });
          sendToPanel({ type: "state", state: "running" });
          break;
        }
        log.waiting(`Radar check #${attempt}: ${check.reason}. Checking again in ${Math.round(radarIntervalMs / 1000)}s...`);
        await new Promise((resolve) => {
          const t = setTimeout(resolve, radarIntervalMs);
          stopController.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
        });
        if (page.isClosed() || stopController.signal.aborted) return;
        await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
        await page.waitForTimeout(800).catch(() => {});
      }
      if (page.isClosed() || stopController.signal.aborted) return;
    }

    await runFlowSafely(page, prompts, credentials);

    // When the browser later lands on a booking page (for example the user
    // opens /appointment/time-slot), cancel the menu prompt and resume there.
    let resumeRequest = null;
    let menuAbort = null;
    let activePage = page;
    const currentPage = () => {
      if (!activePage.isClosed()) return activePage;
      const open = context.pages().filter((candidate) => !candidate.isClosed());
      activePage = open[open.length - 1] || activePage;
      return activePage;
    };
    const watch = async () => {
      const initialKeys = new Map();
      for (const openPage of context.pages()) {
        initialKeys.set(
          openPage,
          (await booking.detectPortalPage(openPage)).key,
        );
      }
      stopWatching = startPortalWatcher(context, {
        initialKeys,
        onEnterBookingPage: (targetPage, current) => {
          if (resumeRequest) return;
          resumeRequest = { page: targetPage, current };
          menuAbort?.abort();
        },
      });
    };
    await watch();

    // Reload the booking code when src/booking.js is changed, keeping the
    // browser and its login (the portal logs out on a browser restart and
    // limits new sign-ins). Then continue from the page that is open.
    const reloadAndContinue = async (reason) => {
      try {
        await reloadBookingCode();
        booking.setOtpProvider?.(PANEL_MODE ? panelOtp : null);
        log.success(
          `Booking code reloaded (${reason}); the browser and login stay as they are.`,
        );
      } catch (error) {
        log.error(
          `Could not load the changed booking code: ${error.message}. Still using the previous code.`,
        );
        return;
      }
      if (resumeRequest) return;
      const target = currentPage();
      resumeRequest = {
        page: target,
        current: await booking.detectPortalPage(target),
      };
      menuAbort?.abort();
    };
    let reloadTimer = null;
    const sourceWatcher = watchSourceFolder(
      fileURLToPath(new URL(".", import.meta.url)),
      (event, file) => {
        if (file !== "booking.js") return;
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          void reloadAndContinue("src/booking.js changed");
        }, 1_500);
      },
    );
    stopSourceWatch = () => {
      clearTimeout(reloadTimer);
      sourceWatcher.close();
    };

    while (context.pages().some((openPage) => !openPage.isClosed())) {
      if (resumeRequest) {
        const { page: targetPage, current } = resumeRequest;
        stopWatching();
        activePage = targetPage;
        await targetPage.bringToFront().catch(() => {});
        log.info(
          `${current.label} is open; continuing the booking from this page.`,
        );
        await runFlowSafely(targetPage, prompts, credentials);
        resumeRequest = null;
        await watch();
        continue;
      }

      let answer;
      menuAbort = new AbortController();
      try {
        if (PANEL_MODE) {
          // The panel's Resume / Reload / Stop buttons replace the keyboard menu.
          sendToPanel({ type: "state", state: "idle" });
          const command = await nextPanelCommand(menuAbort.signal);
          answer = { resume: "b", reload: "r", stop: "q" }[command] || "";
          sendToPanel({ type: "state", state: "running" });
        } else {
          answer = await prompts.question(
            "\n[b] continue booking from this page  [r] reload code and continue  [f] fill labeled fields  [c] inspect flow/errors  [q] quit: ",
            { signal: menuAbort.signal },
          );
        }
      } catch (error) {
        if (error.name === "AbortError") {
          process.stdout.write("\n");
          continue;
        }
        if (prompts.closed) {
          break;
        }
        throw error;
      } finally {
        menuAbort = null;
      }
      const command = answer.trim().toLowerCase();

      if (command === "q") {
        break;
      }
      if (command === "r") {
        await reloadAndContinue("r pressed");
        continue;
      }
      if (command === "b") {
        // Prefer a tab that is on a booking page; otherwise the active tab.
        let target = currentPage();
        let targetInfo = await booking.detectPortalPage(target);
        for (const openPage of context.pages().slice().reverse()) {
          const info = await booking.detectPortalPage(openPage);
          if (booking.isAutoResumePage(info.key)) {
            target = openPage;
            targetInfo = info;
            break;
          }
        }
        resumeRequest = { page: target, current: targetInfo };
        continue;
      }
      if (command === "c") {
        const page = currentPage();
        const pageText = await readPageText(page);
        const current = await booking.detectPortalPage(page);
        const availability = getAvailabilityState(pageText);
        const issues = getPortalIssues(pageText);
        console.log(`Current page: ${current.label}.`);
        console.log(
          `Availability text check: ${availability}. Treat this as a hint and verify the live calendar manually.`,
        );
        if (issues.length === 0) {
          console.log(
            "No recognized booking error is visible in the page text.",
          );
        } else {
          for (const issue of issues) {
            console.warn(`Portal issue: ${issue.label}. ${issue.guidance}`);
          }
        }
        continue;
      }
      if (command === "f") {
        const profile = await loadProfile();
        if (!profile) {
          continue;
        }
        const confirm = (
          await prompts.question(
            "Fill matching, non-sensitive labeled fields from local profile.json? [y/N]: ",
          )
        )
          .trim()
          .toLowerCase();
        if (confirm === "y" || confirm === "yes") {
          const filled = await fillLabeledFields(currentPage(), profile);
          console.log(
            `Filled ${filled} field(s). Review every value before proceeding.`,
          );
        }
        continue;
      }
      console.log("Choose b, r, f, c, or q.");
    }
  } finally {
    if (!context.pages().some((openPage) => !openPage.isClosed())) {
      log.warn("The browser window was closed, so the helper is exiting.");
    }
    if (blockAssets) {
      log.info(`Lightweight asset blocker skipped ${assetRouter.blockedCount()} heavy resource request(s).`);
    }
    if (pooledBrowser && ACTIVE_USER) {
      await saveContextSession(context, SESSIONS_ROOT, ACTIVE_USER);
    }
    stopWatching();
    stopSourceWatch();
    stopJournal();
    prompts.close();
    await context.close().catch(() => {});
    if (pooledBrowser) {
      await pooledBrowser.close().catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(`Automation stopped: ${error.message}`);
  process.exitCode = 1;
});
