import { access, readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { chromium } from "patchright";
import { dismissPortalNotices, runGuidedBookingFlow } from "./booking.js";
import { log } from "./logger.js";
import {
  fillLabeledFields,
  getAvailabilityState,
  getPortalIssues,
  getPortalStep,
} from "./assistant.js";

const PORTAL_URL = "https://appointment.ivacbd.com/";
const PROFILE_PATH = path.resolve("profile.json");
const CREDENTIALS_PATH = path.resolve("credentials.json");
const BROWSER_DATA_PATH = path.resolve("user-data");
const CHECK_INTERVAL_MS = 15_000;

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

async function loadCredentials() {
  try {
    await access(CREDENTIALS_PATH);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("No credentials.json found. Add contactNumber and password to enable automatic sign-in.");
      return null;
    }
    throw error;
  }

  const credentials = JSON.parse(await readFile(CREDENTIALS_PATH, "utf8"));
  if (!credentials || Array.isArray(credentials) || typeof credentials !== "object") {
    throw new Error("credentials.json must contain a JSON object.");
  }

  const contactNumber = credentials.contactNumber;
  const password = credentials.password;
  if (
    typeof contactNumber !== "string" ||
    !contactNumber.trim() ||
    typeof password !== "string" ||
    !password.trim()
  ) {
    console.warn("credentials.json must contain non-empty string fields contactNumber and password. Automatic sign-in is skipped.");
    return null;
  }

  return { contactNumber: contactNumber.trim(), password };
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

function installBrowserErrorReporting(page, credentials) {
  page.on("console", (message) => {
    if (message.type() !== "error") {
      return;
    }
    const text = message.text();
    // Filter non-essential tracking / font / analytics errors
    if (/analytics|gtag|doubleclick|clarity|hotjar|favicon|fonts\.gstatic/i.test(text)) {
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

  page.on("requestfailed", (request) => {
    const url = request.url();
    const resourceType = request.resourceType();
    if (["image", "font", "stylesheet", "media"].includes(resourceType)) {
      return;
    }
    if (/analytics|gtag|doubleclick|clarity|hotjar|google/i.test(url)) {
      return;
    }
    const failure = request.failure();
    if (failure?.errorText === "net::ERR_ABORTED") {
      return;
    }
    log.warn(`Request failed: ${request.method()} ${safeUrlForLog(url, credentials)} (${failure?.errorText || "unknown"})`);
  });
}

function printPageStatus(pageText, previous) {
  const step = getPortalStep(pageText);
  const availability = getAvailabilityState(pageText);

  if (step.key !== previous.step) {
    log.step(step.label, step.guidance);
    previous.step = step.key;
  }

  if (availability === "possible" && previous.availability !== "possible") {
    log.success("Possible appointment availability detected on page.");
  } else if (availability === "unavailable" && previous.availability !== "unavailable") {
    log.info("Page indicates no slot is currently available.");
  }
  previous.availability = availability;
}

function startPortalWatcher(page) {
  const previous = { step: null, availability: null, issues: new Set() };
  let checking = false;
  const check = async () => {
    if (checking || page.isClosed()) {
      return;
    }
    checking = true;
    try {
      await dismissPortalNotices(page);
      printPageStatus(await readPageText(page), previous);
    } catch (error) {
      if (!page.isClosed()) {
        log.warn(`Portal page check failed: ${error.message}`);
      }
    } finally {
      checking = false;
    }
  };
  void check();
  const timer = setInterval(check, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

async function main() {
  const credentials = await loadCredentials();
  const context = await chromium.launchPersistentContext(BROWSER_DATA_PATH, {
    channel: "chrome",
    headless: false,
    args: ["--disable-quic"],
  });

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
  installBrowserErrorReporting(page, credentials);
  context.on("page", (newPage) => {
    installBrowserErrorReporting(newPage, credentials);
  });
  let stopWatching = () => {};
  const prompts = readline.createInterface({ input: stdin, output: stdout });

  try {
    log.banner("IVAC VISA BOOKING AUTOMATION", "Guided Flow • Stops Safely at Payment Step");
    log.info(`Connecting to IVAC portal (${PORTAL_URL})...`);
    await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    await dismissPortalNotices(page);

    if (credentials) {
      log.success("Sign-in credentials loaded from credentials.json");
    } else {
      log.info("Manual sign-in mode (credentials.json not found)");
    }

    try {
      await runGuidedBookingFlow(page, prompts, credentials);
    } catch (error) {
      log.error("Guided booking stopped: " + error.message);
    }
    stopWatching = startPortalWatcher(page);

    while (!page.isClosed()) {
      let answer;
      try {
        answer = await prompts.question(
          "\n[f] fill labeled fields  [c] inspect flow/errors  [q] quit: ",
        );
      } catch (error) {
        if (prompts.closed) {
          break;
        }
        throw error;
      }
      const command = answer.trim().toLowerCase();

      if (command === "q") {
        break;
      }
      if (command === "c") {
        const pageText = await readPageText(page);
        const step = getPortalStep(pageText);
        const availability = getAvailabilityState(pageText);
        const issues = getPortalIssues(pageText);
        console.log(`Portal flow: ${step.label}. ${step.guidance}`);
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
          const filled = await fillLabeledFields(page, profile);
          console.log(
            `Filled ${filled} field(s). Review every value before proceeding.`,
          );
        }
        continue;
      }
      console.log("Choose f, c, or q.");
    }
  } finally {
    stopWatching();
    prompts.close();
    await context.close();
  }
}

main().catch((error) => {
  console.error(`Automation stopped: ${error.message}`);
  process.exitCode = 1;
});
