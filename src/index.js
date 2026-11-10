import { access, readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { chromium } from "patchright";
import { dismissPortalNotices, runGuidedBookingFlow } from "./booking.js";
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
    const url = new URL(value);
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

    const location = message.location();
    const source = location.url
      ? " (" + safeUrlForLog(location.url, credentials) +
        (location.lineNumber ? ":" + location.lineNumber : "") + ")"
      : "";
    console.error(
      "[Browser console error] " +
        redactSensitiveText(message.text(), credentials) +
        source,
    );
  });

  page.on("pageerror", (error) => {
    const stackLine = String(error.stack || "")
      .split("\n")
      .find((line) => /https?:\/\//.test(line));
    const sourceUrl = stackLine?.match(/https?:\/\/[^\s)]+/)?.[0];
    const source = sourceUrl
      ? " (" + safeUrlForLog(sourceUrl, credentials) + ")"
      : "";
    console.error(
      "[Browser page error] " +
        redactSensitiveText(error.name + ": " + error.message, credentials) +
        source,
    );
  });

  page.on("requestfailed", (request) => {
    const failure = request.failure();
    console.error(
      "[Browser request failed] " +
        request.method() + " " + safeUrlForLog(request.url(), credentials) +
        " (" + redactSensitiveText(failure?.errorText || "unknown", credentials) + ")",
    );
  });
}

function printPageStatus(pageText, previous) {
  const step = getPortalStep(pageText);
  const availability = getAvailabilityState(pageText);
  const issues = getPortalIssues(pageText);

  if (step.key !== previous.step) {
    console.log(`\nPortal flow: ${step.label}. ${step.guidance}`);
    previous.step = step.key;
  }

  if (availability === "possible" && previous.availability !== "possible") {
    console.log(
      "Possible appointment availability detected in the open page. Review the calendar yourself; no booking action was taken.",
    );
  } else if (
    availability === "unavailable" &&
    previous.availability !== "unavailable"
  ) {
    console.log(
      "The open page indicates that no appointment slot may be available. Verify the live calendar yourself.",
    );
  } else if (
    availability === "unknown" &&
    previous.availability !== "unknown"
  ) {
    console.log(
      "Appointment availability could not be determined from the visible page text.",
    );
  }
  previous.availability = availability;

  const currentIssueKeys = new Set(issues.map(({ key }) => key));
  for (const issue of issues) {
    if (!previous.issues.has(issue.key)) {
      console.warn(`\nPortal issue: ${issue.label}. ${issue.guidance}`);
    }
  }
  previous.issues = currentIssueKeys;
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
        console.error(`Portal page check failed: ${error.message}`);
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

  const page = context.pages()[0] || (await context.newPage());
  installBrowserErrorReporting(page, credentials);
  context.on("page", (newPage) => {
    installBrowserErrorReporting(newPage, credentials);
  });
  let stopWatching = () => {};
  const prompts = readline.createInterface({ input: stdin, output: stdout });

  try {
    await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    await dismissPortalNotices(page);
    console.log(
      "The portal is open in a visible browser. Starting guided booking automatically from Take Your Appointment.",
    );
    console.log(
      "Browser console errors, uncaught page errors, and failed requests will be shown here; credential values and URL paths are redacted.",
    );
    if (credentials) {
      console.log("Sign-in credentials will be filled from credentials.json.");
    } else {
      console.log("No usable credentials.json found; enter your contact number and password in the browser.");
    }
    console.log(
      "Complete Cloudflare/CAPTCHA and any OTP in the browser. The helper waits for each portal page transition automatically.",
    );
    console.log(
      "The helper stops at payment. It will not enter OTP/CAPTCHA or make payments.",
    );
    console.log(
      "The official FAQ gives a 15-minute limit for the full booking flow; keep the original Webfile and applicant details ready before starting.",
    );
    try {
      await runGuidedBookingFlow(page, prompts, credentials);
    } catch (error) {
      console.error("Guided booking stopped: " + error.message);
      console.error(
        "Review the visible portal page before retrying; the last action may already have taken effect.",
      );
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
