// Handling for a busy or failing portal: overloaded server pages, rate limits,
// Cloudflare interstitials, network errors and blank pages. The helper checks
// what is actually on screen before acting, waits with growing pauses instead
// of hammering the server, and only reloads pages that are safe to reload.
import { log } from "./logger.js";

// Whole-page problems (the portal page itself is replaced or empty).
const PAGE_TROUBLE = [
  {
    key: "server-overloaded",
    label: "Server overloaded",
    pattern: /\b50[234]\b|bad gateway|service (?:temporarily )?unavailable|gateway time-?out|server is (?:busy|overloaded)|origin is unreachable|web server is down/i,
  },
  {
    key: "rate-limited",
    label: "Too many requests",
    pattern: /too many requests|\b429\b|rate limit(?:ed)?|you have been (?:temporarily )?blocked/i,
  },
  {
    key: "cloudflare-check",
    label: "Cloudflare check page",
    pattern: /just a moment|checking (?:if the site connection is secure|your browser)|performing security verification/i,
  },
  {
    key: "network",
    label: "Network problem",
    pattern: /this site can.?t be reached|took too long to respond|err_(?:connection|timed_out|internet|name_not_resolved|network|address)|no internet|you are offline/i,
  },
  {
    key: "server-error",
    label: "Portal error page",
    pattern: /internal server error|something went wrong|application error|an error occurred while processing/i,
  },
];

// Short-lived toast messages that mean "the server could not do it now".
const TOAST_TROUBLE = [
  { key: "rate-limited", label: "Too many requests", pattern: /too many (?:requests|attempts)|rate limit|try again (?:after|in) \d+/i },
  { key: "server-busy", label: "Server busy", pattern: /server (?:is )?busy|service unavailable|gateway|timed? ?out|timeout|network error|failed to fetch|something went wrong|please try again later|request failed/i },
];

export const OTP_SENT_PATTERN = /otp sent|verification code has been sent|code (?:has been )?sent to your/i;
export const OTP_REJECTED_PATTERN = /(?:invalid|incorrect|wrong|expired|mismatch(?:ed)?)\s*(?:otp|code|verification)|(?:otp|code|verification code)\s*(?:is\s*)?(?:invalid|incorrect|wrong|expired|not valid)|otp\s+has\s+expired/i;

// Grows 5s, 10s, 20s, 40s ... up to the cap; rate limits start higher.
export function backoffDelay(attempt, { base = 5_000, cap = 60_000 } = {}) {
  return Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
}

async function readVisibleText(page) {
  return page.evaluate(() => {
    const clone = document.body ? document.body.cloneNode(true) : null;
    if (!clone) return { text: "", title: document.title || "" };
    clone.querySelectorAll('[class*="marquee"], script, style, template, noscript').forEach((node) => node.remove());
    return {
      text: (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim(),
      title: document.title || "",
    };
  }).catch(() => ({ text: "", title: "" }));
}

async function readToasts(page) {
  return page.locator('[data-sonner-toast], section[aria-label*="Notifications"] li, [role="region"][aria-label*="Notifications"] li, [role="status"], [role="alert"]')
    .evaluateAll((nodes) => nodes
      .map((node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean))
    .catch(() => []);
}

// Returns { key, label, scope: "page" | "toast", text } or null.
export async function detectServerTrouble(page) {
  if (page.isClosed()) return null;
  let url = "";
  try {
    url = page.url();
  } catch {}
  if (/^chrome-error:/i.test(url)) {
    return { key: "network", label: "Network problem", scope: "page", text: "The browser could not load the page." };
  }
  const { text, title } = await readVisibleText(page);
  // A real portal page has plenty of text; an error page is short.
  const shortPage = text.length < 700;
  for (const trouble of PAGE_TROUBLE) {
    if (trouble.pattern.test(title) || (shortPage && trouble.pattern.test(text))) {
      return { key: trouble.key, label: trouble.label, scope: "page", text: (text || title).slice(0, 160) };
    }
  }
  if (text.length < 20 && url && !/^about:blank/i.test(url)) {
    return { key: "blank", label: "Blank page", scope: "page", text: "" };
  }
  for (const toast of await readToasts(page)) {
    const match = TOAST_TROUBLE.find(({ pattern }) => pattern.test(toast));
    if (match) {
      return { key: match.key, label: match.label, scope: "toast", text: toast.slice(0, 160) };
    }
  }
  return null;
}

// Waits out a busy or failing portal. Page-level problems are reloaded with
// growing pauses (a reload is a plain GET of the same page, so it is safe);
// a Cloudflare check page is left to finish; toast-level problems just wait.
// Returns true when the page looks normal again, false when it gave up.
export async function waitOutServerTrouble(page, { maxWait = 15 * 60_000, reason = "", baseDelay = 5_000 } = {}) {
  const started = Date.now();
  let attempt = 0;
  let announced = false;
  while (!page.isClosed() && Date.now() - started < maxWait) {
    const trouble = await detectServerTrouble(page);
    if (!trouble) {
      if (announced) log.success(`The portal is responding again${reason ? ` (${reason})` : ""}.`);
      return true;
    }
    attempt += 1;
    announced = true;
    const rateLimited = trouble.key === "rate-limited";
    const delay = backoffDelay(attempt, { base: rateLimited ? 12 * baseDelay : baseDelay, cap: rateLimited ? 120_000 : 60_000 });
    if (trouble.key === "cloudflare-check") {
      log.waiting(`Cloudflare is checking the browser${reason ? ` (${reason})` : ""}; waiting (complete it in the browser if it asks).`);
      await page.waitForTimeout(5_000).catch(() => {});
      continue;
    }
    log.warn(`Server trouble: ${trouble.label}${trouble.text ? ` - "${trouble.text}"` : ""}. Waiting ${Math.round(delay / 1000)}s before ${trouble.scope === "page" ? "reloading" : "trying again"} (attempt ${attempt}).`);
    await page.waitForTimeout(delay).catch(() => {});
    if (trouble.scope === "page") {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch((error) => {
        log.warn(`Reload did not finish: ${error.message.split("\n")[0]}`);
      });
      await page.waitForTimeout(1_500).catch(() => {});
    } else {
      // A toast is a one-off answer; let the caller retry its own action.
      return false;
    }
  }
  if (!page.isClosed()) {
    log.warn(`The portal still looks unavailable after ${Math.round((Date.now() - started) / 60_000)} minute(s).`);
  }
  return false;
}

// Opens a URL, retrying through network errors and overloaded-server pages.
export async function gotoWithRecovery(page, url, { attempts = 8 } = {}) {
  for (let attempt = 1; attempt <= attempts && !page.isClosed(); attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (error) {
      const delay = backoffDelay(attempt);
      log.warn(`Could not open ${new URL(url).pathname} (${error.message.split("\n")[0]}). Retrying in ${Math.round(delay / 1000)}s (attempt ${attempt} of ${attempts}).`);
      await page.waitForTimeout(delay).catch(() => {});
      continue;
    }
    if (await waitOutServerTrouble(page, { reason: `opening ${new URL(url).pathname}`, maxWait: 10 * 60_000 })) {
      return true;
    }
  }
  return false;
}
