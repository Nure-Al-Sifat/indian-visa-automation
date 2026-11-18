// Page journal: records the structure of every portal page the browser visits,
// so the helper's page detection and step handling can be checked against the
// real site. Records stay on this computer in logs/ (ignored by git).
//
// What is saved: URL path (no query string), the detected page, title,
// headings, buttons and links (text, enabled/disabled), form fields (type,
// name, label, placeholder, disabled; never their values), Cloudflare status,
// and a cleaned HTML copy (scripts removed, input values, tokens and long digit
// runs such as phone numbers blanked).
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectPortalPage } from "./booking.js";
import { log } from "./logger.js";
import { safeAccountName } from "./accounts.js";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Each account keeps its own journal when several run side by side.
const JOURNAL_USER = (process.env.IVAC_USER || "").trim() ? safeAccountName(process.env.IVAC_USER) : "";
export const JOURNAL_DIR = JOURNAL_USER ? path.join(PROJECT_ROOT, "logs", JOURNAL_USER) : path.join(PROJECT_ROOT, "logs");
const JOURNAL_FILE = path.join(JOURNAL_DIR, "page-journal.jsonl");
const PAGES_DIR = path.join(JOURNAL_DIR, "pages");
const CHECK_INTERVAL_FULL_MS = 5_000;
const CHECK_INTERVAL_ON_DEMAND_MS = 15_000;

// Runs inside the page.
function describePage(includeHtml = true) {
  const clean = (value, max = 120) => String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\d{6,}/g, (digits) => `[${digits.length} digits]`)
    .trim()
    .slice(0, max);
  const isVisible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  };
  const inBanner = (element) => Boolean(element.closest('[class*="marquee"]'));
  const labelFor = (element) => clean(
    Array.from(element.labels || []).map((label) => label.innerText).join(" ") ||
    element.getAttribute("aria-label") || "",
    80,
  );

  const headings = Array.from(document.querySelectorAll("h1, h2, h3, h4, [role='heading']"))
    .filter((element) => isVisible(element) && !inBanner(element))
    .map((element) => clean(element.innerText, 100))
    .filter(Boolean)
    .slice(0, 15);
  const buttons = Array.from(document.querySelectorAll("button, [role='button'], input[type='submit'], input[type='button']"))
    .filter((element) => !inBanner(element))
    .map((element) => ({
      text: clean(element.innerText || element.value || element.getAttribute("aria-label"), 60),
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      visible: isVisible(element),
      type: element.getAttribute("type") || "",
    }))
    .filter((button) => button.text)
    .slice(0, 60);
  const links = Array.from(document.querySelectorAll("a[href]"))
    .filter((element) => isVisible(element) && !inBanner(element))
    .map((element) => {
      let href = element.getAttribute("href") || "";
      try { href = new URL(href, location.href).pathname; } catch {}
      return { text: clean(element.innerText, 60), href };
    })
    .slice(0, 30);
  const fields = Array.from(document.querySelectorAll("input, select, textarea"))
    .filter((element) => !["hidden"].includes((element.getAttribute("type") || "").toLowerCase()) || /turnstile|captcha/i.test(element.name))
    .map((element) => ({
      tag: element.tagName.toLowerCase(),
      type: (element.getAttribute("type") || "").toLowerCase(),
      name: clean(element.getAttribute("name"), 60),
      id: clean(element.id, 60),
      label: labelFor(element),
      placeholder: clean(element.getAttribute("placeholder"), 60),
      disabled: Boolean(element.disabled),
      visible: isVisible(element),
      checked: element.type === "checkbox" ? Boolean(element.checked) : undefined,
      options: element.tagName === "SELECT" ? Array.from(element.options).map((option) => clean(option.label, 40)).slice(0, 20) : undefined,
    }))
    .slice(0, 40);
  const tokenField = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
  const turnstileBox = document.querySelector("#cf-turnstile, .cf-turnstile, [data-sitekey]");
  const turnstileRect = turnstileBox?.getBoundingClientRect();
  const dialogs = Array.from(document.querySelectorAll("[role='dialog'], [aria-modal='true'], .modal"))
    .filter(isVisible)
    .map((element) => clean(element.innerText, 160))
    .slice(0, 5);
  const alerts = Array.from(document.querySelectorAll("[role='alert'], [aria-live='assertive'], .toast, .alert"))
    .filter(isVisible)
    .map((element) => clean(element.innerText, 160))
    .filter(Boolean)
    .slice(0, 5);

  let html = "";
  if (includeHtml) {
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll("script, style, noscript, template, svg, [class*='marquee']").forEach((node) => node.remove());
    clone.querySelectorAll("input, textarea").forEach((node) => {
      if (node.hasAttribute("value")) node.setAttribute("value", "");
      node.textContent = "";
    });
    clone.querySelectorAll("img").forEach((node) => node.removeAttribute("src"));
    html = clone.outerHTML.replace(/\d{6,}/g, (digits) => `[${digits.length} digits]`);
  }

  return {
    title: clean(document.title, 100),
    headings,
    buttons,
    links,
    fields,
    dialogs,
    alerts,
    turnstile: {
      present: Boolean(tokenField || turnstileBox),
      solved: Boolean(tokenField && tokenField.value && tokenField.value.trim()),
      onScreen: Boolean(turnstileRect && turnstileRect.top < innerHeight && turnstileRect.bottom > 0),
    },
    scroll: { y: Math.round(scrollY), pageHeight: document.documentElement.scrollHeight, viewportHeight: innerHeight },
    html,
  };
}

function signatureOf(entry) {
  return JSON.stringify([
    entry.path,
    entry.page.key,
    entry.headings,
    entry.buttons.map((button) => `${button.text}:${button.disabled}`),
    entry.fields.map((field) => `${field.type}:${field.name}:${field.disabled}`),
    entry.dialogs,
    entry.alerts,
    entry.turnstile.solved,
  ]);
}

export async function recordPage(page, { tab = 1, reason = "change", includeHtml = true } = {}) {
  if (page.isClosed()) return null;
  let pathname = "";
  try {
    pathname = new URL(page.url()).pathname;
  } catch {}
  const detected = await detectPortalPage(page).catch(() => ({ key: "unknown", label: "Unrecognized page" }));
  const described = await page.evaluate(describePage, includeHtml).catch(() => null);
  if (!described) return null;
  const { html, ...structure } = described;
  return {
    time: new Date().toISOString(),
    tab,
    reason,
    path: pathname,
    page: detected,
    ...structure,
    html,
  };
}

async function saveEntry(entry, { writeHtml = true, uniqueSuffix = "" } = {}) {
  await mkdir(PAGES_DIR, { recursive: true });
  const { html, ...structure } = entry;
  await appendFile(JOURNAL_FILE, `${JSON.stringify(structure)}\n`, "utf8");
  if (writeHtml && html) {
    const safePath = (entry.path || "root").replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root";
    const suffix = uniqueSuffix ? `__${uniqueSuffix}` : "";
    await writeFile(path.join(PAGES_DIR, `${entry.page.key}__${safePath}${suffix}.html`), html, "utf8");
  }
}

export async function captureErrorSnapshot(page, reason = "error") {
  if (!page || page.isClosed()) return null;
  try {
    const entry = await recordPage(page, { reason: `snapshot:${reason}`, includeHtml: true });
    if (!entry) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeReason = String(reason || "err").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 32);
    await saveEntry(entry, { writeHtml: true, uniqueSuffix: `${safeReason}_${stamp}` });
    return entry;
  } catch {
    return null;
  }
}

// Records every tab whenever its page changes.
// In "on-demand" mode (default), skips expensive 5s DOM cloning and only captures
// full HTML snapshots on unrecognized pages or visible portal alerts.
export function startPageJournal(context, { onPage = null, mode = process.env.IVAC_JOURNAL_MODE || "on-demand" } = {}) {
  const fullMode = mode === "full";
  const checkIntervalMs = fullMode ? CHECK_INTERVAL_FULL_MS : CHECK_INTERVAL_ON_DEMAND_MS;
  const lastSignature = new Map();
  const lastAlertText = new Map();
  let busy = false;

  const recordAll = async (reason) => {
    if (busy) return;
    busy = true;
    try {
      const pages = context.pages();
      for (let index = 0; index < pages.length; index += 1) {
        const page = pages[index];
        const entry = await recordPage(page, { tab: index + 1, reason, includeHtml: fullMode });
        if (!entry) continue;
        const signature = signatureOf(entry);
        if (lastSignature.get(page) === signature) continue;
        lastSignature.set(page, signature);

        // In on-demand mode, capture HTML only if the page is unrecognized or showing an alert
        let entryToSave = entry;
        let shouldWriteHtml = fullMode;
        if (!fullMode && (entry.page.key === "unknown" || entry.alerts.length > 0)) {
          const withHtml = await recordPage(page, { tab: index + 1, reason: `${reason}:detail`, includeHtml: true });
          if (withHtml) {
            entryToSave = withHtml;
            shouldWriteHtml = true;
          }
        }
        await saveEntry(entryToSave, { writeHtml: shouldWriteHtml });
        try { onPage?.(entryToSave); } catch {}

        // Surface new portal toast/alert text directly in the activity log
        if (entryToSave.alerts.length > 0) {
          const alertJoined = entryToSave.alerts.join(" | ");
          if (lastAlertText.get(page) !== alertJoined) {
            lastAlertText.set(page, alertJoined);
            log.warn(`Portal alert on ${entryToSave.path || "/"}: ${alertJoined}`);
          }
        } else {
          lastAlertText.delete(page);
        }

        const enabled = entryToSave.buttons.filter((button) => button.visible && !button.disabled).map((button) => button.text).slice(0, 4);
        console.log(`${log.colors.gray}📝 Journal: tab ${entryToSave.tab} ${entryToSave.path || "/"} → ${entryToSave.page.label}${enabled.length ? ` | buttons: ${enabled.join(", ")}` : ""}${entryToSave.turnstile.present ? ` | Cloudflare: ${entryToSave.turnstile.solved ? "passed" : entryToSave.turnstile.onScreen ? "on screen, not passed" : "off screen"}` : ""}${log.colors.reset}`);
      }
    } catch (error) {
      console.log(`${log.colors.gray}📝 Journal skipped a check: ${error.message}${log.colors.reset}`);
    } finally {
      busy = false;
    }
  };

  const timers = new Map();
  const attach = (page) => {
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      clearTimeout(timers.get(page));
      timers.set(page, setTimeout(() => recordAll("navigation"), fullMode ? 2_000 : 1_200));
    });
  };
  context.pages().forEach(attach);
  context.on("page", attach);

  const interval = setInterval(() => recordAll("interval"), checkIntervalMs);
  void recordAll("start");
  log.info(`Page journal (${fullMode ? "full 5s" : "on-demand lightweight"}) → ${path.relative(PROJECT_ROOT, JOURNAL_FILE)}`);
  return () => {
    clearInterval(interval);
    for (const timer of timers.values()) clearTimeout(timer);
  };
}
