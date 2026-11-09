import { access, readFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { chromium } from "playwright";
import { fillLabeledFields, getAvailabilityState } from "./assistant.js";

const PORTAL_URL = "https://appointment.ivacbd.com/";
const PROFILE_PATH = path.resolve("profile.json");
const BROWSER_DATA_PATH = path.resolve("user-data");
const CHECK_INTERVAL_MS = 15_000;

async function loadProfile() {
  try {
    await access(PROFILE_PATH);
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log("No profile.json found. Copy profile.example.json to profile.json to enable optional autofill.");
      return null;
    }
    throw error;
  }

  const profile = JSON.parse(await readFile(PROFILE_PATH, "utf8"));
  if (!profile || Array.isArray(profile) || typeof profile !== "object") {
    throw new Error("profile.json must contain a JSON object mapping visible field labels to string values.");
  }
  return profile;
}

async function readPageText(page) {
  if (page.isClosed()) {
    return "";
  }
  return page.locator("body").innerText({ timeout: 5_000 });
}

function startAvailabilityWatcher(page) {
  let previousState = "unknown";
  let checking = false;
  const timer = setInterval(async () => {
    if (checking || page.isClosed()) {
      return;
    }
    checking = true;
    try {
      const state = getAvailabilityState(await readPageText(page));
      if (state === "possible" && previousState !== "possible") {
        console.log("\nPossible appointment availability detected in the open page. Review it yourself; no booking action was taken.");
      } else if (state === "unknown" && previousState === "possible") {
        console.log("\nThe availability message is no longer visible.");
      }
      previousState = state;
    } catch (error) {
      if (!page.isClosed()) {
        console.error(`Availability check failed: ${error.message}`);
      }
    } finally {
      checking = false;
    }
  }, CHECK_INTERVAL_MS);
  return () => clearInterval(timer);
}

async function main() {
  const context = await chromium.launchPersistentContext(BROWSER_DATA_PATH, {
    headless: false,
  });
  const page = context.pages()[0] || await context.newPage();
  const stopWatching = startAvailabilityWatcher(page);
  const prompts = readline.createInterface({ input: stdin, output: stdout });

  try {
    await page.goto(PORTAL_URL, { waitUntil: "domcontentloaded" });
    console.log("The portal is open in a visible browser. Sign in and complete all steps yourself.");
    console.log("This helper never submits forms, reloads the page, or handles CAPTCHA, OTP, queue, or payment steps.");

    while (!page.isClosed()) {
      let answer;
      try {
        answer = await prompts.question("\n[f] fill labeled fields  [c] check open page  [q] quit: ");
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
        const state = getAvailabilityState(await readPageText(page));
        console.log(`Availability text check: ${state}. Treat this as a hint and verify the page manually.`);
        continue;
      }
      if (command === "f") {
        const profile = await loadProfile();
        if (!profile) {
          continue;
        }
        const confirm = (await prompts.question("Fill matching, non-sensitive labeled fields from local profile.json? [y/N]: "))
          .trim()
          .toLowerCase();
        if (confirm === "y" || confirm === "yes") {
          const filled = await fillLabeledFields(page, profile);
          console.log(`Filled ${filled} field(s). Review every value before proceeding.`);
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
