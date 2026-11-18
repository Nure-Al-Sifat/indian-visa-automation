import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPortalIssues, getPortalStep } from "./assistant.js";
import { log } from "./logger.js";
import { OTP_REJECTED_PATTERN, OTP_SENT_PATTERN, detectServerTrouble, gotoWithRecovery, waitOutServerTrouble } from "./resilience.js";
import { safeAccountName } from "./accounts.js";

const FILE_INPUT_SELECTOR = 'input[type="file"]';
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOC_FILE_DIR = path.join(PROJECT_ROOT, "doc_file");
const ADD_APPLICANT_LABELS = [
  "Add Applicant",
  "Add Another Applicant",
  "Add Additional Applicant",
  "Add New Applicant",
  "Add Family Member",
  "Add Secondary Applicant",
  "Add Other Applicant",
  "Add Webfile",
  "Add Another Webfile",
  "Add Additional Webfile",
  "Add Secondary Webfile",
];
const lastVisibleIssuesByPage = new WeakMap();

async function askYesNo(prompts, message) {
  const answer = (await prompts.question(`${message} [y/N]: `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function findUniqueControl(page, roles, exactNames) {
  for (const role of roles) {
    for (const name of exactNames) {
      const locator = page.getByRole(role, { name, exact: true });
      const count = await locator.count().catch(() => 0);
      if (count === 1) {
        if (await locator.isVisible().catch(() => false) && await locator.isEnabled().catch(() => false)) {
          return { found: true, locator, label: name };
        }
        return { found: false, ambiguous: false, label: name };
      }
      if (count > 1) {
        const visible = [];
        for (let i = 0; i < count; i++) {
          if (await locator.nth(i).isVisible().catch(() => false) && await locator.nth(i).isEnabled().catch(() => false)) {
            visible.push(locator.nth(i));
          }
        }
        if (visible.length === 1) {
          return { found: true, locator: visible[0], label: name };
        }
        if (visible.length > 1) {
          if (/take your appointment|next step|add applicant|confirm all information/i.test(name)) {
            return { found: true, locator: visible[0], label: name };
          }
          return { found: false, ambiguous: true, label: name };
        }
      }
    }
  }

  // Flexible fallback: regex name or element text
  for (const name of exactNames) {
    const pattern = new RegExp(escapeRegex(name), "i");
    const candidates = [
      ...roles.map((role) => page.getByRole(role, { name: pattern })),
      page.locator('a, button, [role="button"]').filter({ hasText: pattern }),
      page.getByText(pattern),
    ];

    for (const candidate of candidates) {
      const count = await candidate.count().catch(() => 0);
      const visible = [];
      for (let i = 0; i < count; i++) {
        const el = candidate.nth(i);
        if (await el.isVisible().catch(() => false) && await el.isEnabled().catch(() => false)) {
          visible.push(el);
        }
      }
      if (visible.length === 1) {
        return { found: true, locator: visible[0], label: name };
      }
      if (visible.length > 1) {
        if (/take your appointment|next step|add applicant|confirm all information/i.test(name)) {
          return { found: true, locator: visible[0], label: name };
        }
        const buttonsOrLinks = [];
        for (const el of visible) {
          const isClickable = await el.evaluate((node) => {
            return node.tagName === "A" || node.tagName === "BUTTON" || node.getAttribute("role") === "button"
              || Boolean(node.closest("a, button, [role='button']"));
          }).catch(() => false);
          if (isClickable) {
            buttonsOrLinks.push(el);
          }
        }
        if (buttonsOrLinks.length === 1) {
          return { found: true, locator: buttonsOrLinks[0], label: name };
        }
        if (buttonsOrLinks.length > 1 && /take your appointment|next step|add applicant|confirm all information/i.test(name)) {
          return { found: true, locator: buttonsOrLinks[0], label: name };
        }
        return { found: false, ambiguous: true, label: name };
      }
    }
  }

  return { found: false, ambiguous: false };
}

async function findAddApplicantControl(page) {
  const named = await findUniqueControl(page, ["button", "link"], ADD_APPLICANT_LABELS);
  if (named.found || named.ambiguous) {
    return named;
  }

  const controls = page.locator('button, a, [role="button"]');
  const count = await controls.count().catch(() => 0);
  const matches = [];
  for (let index = 0; index < count; index += 1) {
    const control = controls.nth(index);
    if (!await control.isVisible().catch(() => false) || !await control.isEnabled().catch(() => false)) {
      continue;
    }
    const info = await control.evaluate((element) => {
      const directLabel = [
        element.getAttribute("aria-label") || "",
        element.getAttribute("title") || "",
        element.innerText || "",
        element.textContent || "",
      ].join(" ").replace(/\s+/g, " ").trim();
      let ancestor = element.parentElement;
      let context = "";
      for (let depth = 0; ancestor && depth < 4; depth += 1, ancestor = ancestor.parentElement) {
        const text = (ancestor.innerText || "").replace(/\s+/g, " ").trim();
        if (text.length > 0 && text.length < 400) {
          context += ` ${text}`;
        }
      }
      return { directLabel, context };
    }).catch(() => ({ directLabel: "", context: "" }));
    const looksLikeAddControl = /\b(?:add|plus)\b|^\s*\+/i.test(info.directLabel);
    const mentionsApplicantSlot = /applicant|web\s*file|secondary|family member/i.test(`${info.directLabel} ${info.context}`);
    if (looksLikeAddControl && mentionsApplicantSlot) {
      matches.push(control);
    }
  }

  if (matches.length === 1) {
    return { found: true, locator: matches[0], label: "Add applicant" };
  }
  return { found: false, ambiguous: matches.length > 1 };
}

export async function findTakeAppointmentControl(page) {
  const candidates = [
    page.locator('button, a, [role="button"]').filter({ hasText: /take your appointment/i }),
    page.getByRole("button", { name: /take your appointment/i }),
    page.getByRole("link", { name: /take your appointment/i }),
    page.getByText(/take your appointment/i),
  ];

  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const el = candidate.nth(i);
      if (await el.isVisible().catch(() => false) && await el.isEnabled().catch(() => false)) {
        return el;
      }
    }
  }
  return null;
}

export async function unblockInspectAndPaste(page) {
  try {
    await page.evaluate(() => {
      const allow = (e) => e.stopImmediatePropagation();
      ["copy", "cut", "paste", "contextmenu"].forEach((eventType) => {
        document.addEventListener(eventType, allow, true);
        window.addEventListener(eventType, allow, true);
      });
      document.oncontextmenu = null;
      document.onpaste = null;
      document.oncopy = null;
      document.querySelectorAll("input, textarea").forEach((el) => {
        el.removeAttribute("onpaste");
        el.removeAttribute("oncontextmenu");
        el.removeAttribute("oncopy");
      });
    });
  } catch {}
}

export async function setLoginInputValue(page, locator, value) {
  if (!await waitForPortalNoticesClosed(page, 2_000)) {
    return false;
  }
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ timeout: 5_000 }).catch(() => {});

  await locator.evaluate((input, text) => {
    input.removeAttribute("onpaste");
    input.removeAttribute("oncontextmenu");
    input.removeAttribute("readonly");

    const proto = Object.getPrototypeOf(input);
    const nativeSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set || Object.getOwnPropertyDescriptor(proto, "value")?.set;

    if (nativeSetter) {
      nativeSetter.call(input, text);
    } else {
      input.value = text;
    }

    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }, value).catch(() => {});

  await locator.dispatchEvent("blur").catch(() => {});

  let currentVal = await locator.inputValue().catch(() => "");
  if (currentVal === value) {
    return true;
  }

  // Fallback: clear and pressSequentially
  await locator.click({ timeout: 2_000 }).catch(() => {});
  await locator.press("Control+A").catch(() => {});
  await locator.press("Backspace").catch(() => {});
  await locator.pressSequentially(value, { delay: 30, timeout: 5_000 }).catch(() => {});
  currentVal = await locator.inputValue().catch(() => "");
  return currentVal === value;
}

async function clickPortalControl(page, locator, options = {}) {
  if (!await waitForPortalNoticesClosed(page, 3_000)) {
    return false;
  }
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {});
    await locator.click({ timeout: 5_000, ...options });
    return true;
  } catch {
    try {
      await locator.click({ force: true, timeout: 3_000 });
      return true;
    } catch {
      const clicked = await locator.evaluate((el) => {
        el.click();
        return true;
      }).catch(() => false);
      return clicked;
    }
  }
}

async function waitForAnyState(candidates, timeout = 15_000) {
  if (candidates.length === 0) {
    return false;
  }

  const waits = candidates.map(({ locator, state = "visible" }) =>
    locator.first().waitFor({ state, timeout }).then(() => true),
  );
  try {
    return await Promise.any(waits);
  } catch {
    return false;
  }
}

const PORTAL_NOTICE_TITLES = [
  { label: "Important Notice", exact: true, pattern: "Important Notice" },
  {
    label: "Visa Undertaking advisory",
    exact: false,
    pattern: /Mandatory Submission of Visa Undertaking Form/i,
  },
  {
    label: "Fraudulent appointment advisory",
    exact: false,
    pattern: /Advisory on Fraudulent Visa Appointment Slot Offers/i,
  },
];

// Runs inside the page. Returns the offset of a notice title's own close
// control, or null when the title has no close control near it.
function findNoticeCloseControl(title) {
  const isVisible = (control) => {
    const rect = control.getBoundingClientRect();
    const style = getComputedStyle(control);
    return rect.width > 0 && rect.height > 0 &&
      style.visibility !== "hidden" && style.display !== "none";
  };

  let ancestor = title;
  for (let depth = 0; ancestor && depth < 12; depth += 1, ancestor = ancestor.parentElement) {
    const controls = Array.from(ancestor.querySelectorAll("button, [role='button']"));
    const visibleControls = controls.filter(isVisible);
    const namedClose = visibleControls.filter((control) => /close|dismiss/i.test([
      control.getAttribute("aria-label") || "",
      control.getAttribute("title") || "",
      control.innerText || "",
    ].join(" ")));
    if (namedClose.length === 1) {
      return { depth, index: controls.indexOf(namedClose[0]) };
    }

    const ancestorRect = ancestor.getBoundingClientRect();
    const topRightClose = visibleControls.filter((control) => {
      const rect = control.getBoundingClientRect();
      return rect.width <= 80 && rect.height <= 80 &&
        rect.top <= ancestorRect.top + 80 &&
        rect.right >= ancestorRect.right - 80 &&
        rect.left >= ancestorRect.right - 100;
    });
    if (topRightClose.length === 1) {
      return { depth, index: controls.indexOf(topRightClose[0]) };
    }
  }
  return null;
}

function getNoticeTitleLocator(page, notice) {
  return notice.exact
    ? page.getByText(notice.pattern, { exact: true })
    : page.getByText(notice.pattern);
}

// The portal also renders these notice titles as ordinary dashboard text after
// sign-in. Only a title inside a dialog, or one that owns a visible close
// control, is an open modal that should block the flow.
async function findActivePortalNotice(page) {
  for (const notice of PORTAL_NOTICE_TITLES) {
    const titleLocator = getNoticeTitleLocator(page, notice);
    const count = await titleLocator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const title = titleLocator.nth(index);
      if (!await title.isVisible().catch(() => false)) {
        continue;
      }
      const closeInfo = await title.evaluate(findNoticeCloseControl).catch(() => null);
      const inDialog = await page.getByRole("dialog").filter({ has: title })
        .count().catch(() => 0) === 1;
      if (closeInfo || inDialog) {
        return { label: notice.label, title, closeInfo, inDialog };
      }
    }
  }
  return null;
}

async function hasBlockingPortalNotice(page) {
  return await findActivePortalNotice(page) !== null;
}

async function waitForPortalNoticesClosed(page, timeout = 30_000) {
  let lastCloseAttempt = 0;
  let lastNoticeMessage = 0;
  const deadline = Date.now() + timeout;
  while (!page.isClosed() && Date.now() < deadline) {
    if (!await hasBlockingPortalNotice(page)) {
      return true;
    }
    const now = Date.now();
    if (now - lastCloseAttempt >= 1_000) {
      await dismissPortalNotices(page);
      lastCloseAttempt = Date.now();
    }
    if (now - lastNoticeMessage >= 10_000) {
      console.log("A portal notice is blocking the next action. Close it with its X button; the helper is waiting.");
      lastNoticeMessage = now;
    }
    await page.waitForTimeout(300).catch(() => {});
  }
  return !await hasBlockingPortalNotice(page);
}

async function waitForPortalStep(page, label, candidates, timeout = 60_000) {
  let lastHeartbeat = 0;
  let lastTroubleCheck = Date.now();
  let deadline = Date.now() + timeout;
  while (!page.isClosed() && Date.now() < deadline) {
    if (!await waitForPortalNoticesClosed(page, 2_000)) {
      return false;
    }
    if (await waitForAnyState(candidates, 150)) {
      console.log(`Portal step ready: ${label}.`);
      return true;
    }

    const now = Date.now();
    // Under heavy load the portal may show an error or blank page instead of
    // the next step. Recover it, then give the step its full time again.
    if (now - lastTroubleCheck >= 8_000) {
      lastTroubleCheck = now;
      const trouble = await detectServerTrouble(page);
      if (trouble && trouble.scope === "page") {
        if (!await waitOutServerTrouble(page, { reason: `waiting for ${label}` })) {
          return false;
        }
        deadline = Date.now() + timeout;
        continue;
      }
    }
    if (now - lastHeartbeat >= 30_000) {
      await reportVisibleIssues(page);
      console.log(`Still waiting for the portal to show: ${label}.`);
      lastHeartbeat = now;
    }
    await page.waitForTimeout(300).catch(() => {});
  }
  return false;
}

async function waitForEnabledPortalStep(page, label, locators, timeout = 60_000) {
  let lastHeartbeat = 0;
  const deadline = Date.now() + timeout;
  while (!page.isClosed() && Date.now() < deadline) {
    if (!await waitForPortalNoticesClosed(page, 2_000)) {
      return false;
    }
    if (await waitForAnyEnabled(page, locators, 150)) {
      console.log(`Portal step ready: ${label}.`);
      return true;
    }

    const now = Date.now();
    if (now - lastHeartbeat >= 30_000) {
      await reportVisibleIssues(page);
      console.log(`Still waiting for the portal to show: ${label}.`);
      lastHeartbeat = now;
    }
    await page.waitForTimeout(300).catch(() => {});
  }
  return false;
}

async function waitForUniqueControlUntilReady(page, roles, exactNames, label, timeout = 60_000) {
  let lastHeartbeat = 0;
  const deadline = Date.now() + timeout;
  while (!page.isClosed() && Date.now() < deadline) {
    if (!await waitForPortalNoticesClosed(page, 2_000)) {
      return { found: false, ambiguous: false };
    }
    const result = await findUniqueControl(page, roles, exactNames);
    if (result.found || result.ambiguous) {
      return result;
    }
    const now = Date.now();
    if (now - lastHeartbeat >= 30_000) {
      await reportVisibleIssues(page);
      console.log(`Still waiting for an enabled ${label} control.`);
      lastHeartbeat = now;
    }
    await page.waitForTimeout(300).catch(() => {});
  }
  return { found: false, ambiguous: false };
}

async function waitForAnyEnabled(page, locators, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const locator of locators) {
      const count = await locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = locator.nth(index);
        if (
          await candidate.isVisible().catch(() => false) &&
          await candidate.isEnabled().catch(() => false)
        ) {
          return true;
        }
      }
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function waitForBookingStart(page) {
  return waitForPortalStep(page, "sign-in or booking page", [
    ...page.frames().map((frame) => ({
      locator: frame.locator('input[type="password"]'),
      state: "visible",
    })),
    { locator: page.getByRole("button", { name: /next step/i }) },
    { locator: page.getByRole("link", { name: /next step/i }) },
    { locator: page.locator('a, button, [role="button"]').filter({ hasText: /next step/i }) },
    { locator: page.getByRole("button", { name: /book your appointment|book appointment/i }) },
    { locator: page.getByRole("link", { name: /book your appointment|book appointment/i }) },
    { locator: page.locator(FILE_INPUT_SELECTOR).first(), state: "attached" },
    // Seen live: with Webfiles and Mission already saved, Take Your
    // Appointment opens a later step directly (here /appointment/time-slot).
    { locator: page.locator('button, [role="button"]').filter({ hasText: CONTINUE_BOOKING_PATTERN }) },
    { locator: page.locator('button, [role="button"]').filter({ hasText: MISSION_CONFIRM_PATTERN }) },
    { locator: page.getByText(/waiting for booking portal/i) },
    { locator: page.getByRole("button", { name: /pay now/i }) },
  ]);
}

// When the portal jumps straight to a later booking step (Mission, waiting
// room, date picker, declaration, payment), continue from that step.
async function continueIfLaterStep(page, prompts) {
  const current = await detectPortalPage(page);
  if (!RESUMABLE_PAGES.has(current.key)) {
    return false;
  }
  log.step("Current Page", `${current.label}: the portal resumed the saved booking here`);
  await continueBookingFrom(page, prompts, current.key);
  return true;
}

async function isWebfileStepReady(page) {
  if (!await waitForPortalNoticesClosed(page, 2_000)) {
    return false;
  }
  return waitForAnyState([
    { locator: page.locator(FILE_INPUT_SELECTOR).first(), state: "attached" },
    { locator: page.getByText(/upload primary applicant(?:'s|’s) webfile/i) },
    { locator: page.getByRole("button", { name: /save\s*&\s*continue|save\s+and\s+continue/i }) },
    { locator: page.getByRole("heading", { name: /please confirm your details/i }) },
  ], 100);
}

async function isActiveBookingStepReady(page) {
  if (!await waitForPortalNoticesClosed(page, 2_000)) {
    return false;
  }
  return waitForAnyState([
    { locator: page.getByRole("button", { name: /next step/i }) },
    { locator: page.getByRole("link", { name: /next step/i }) },
    { locator: page.locator('a, button, [role="button"]').filter({ hasText: /next step/i }) },
    { locator: page.locator(FILE_INPUT_SELECTOR).first(), state: "attached" },
    { locator: page.getByRole("button", { name: /save\s*&\s*continue|save\s+and\s+continue/i }) },
    { locator: page.getByRole("heading", { name: /please confirm your details/i }) },
    { locator: page.getByLabel(/select ivac cent(?:re|er)/i) },
    { locator: page.locator('button, [role="button"]').filter({ hasText: MISSION_CONFIRM_PATTERN }) },
    { locator: page.locator('input[type="date"]'), state: "visible" },
    { locator: page.getByRole("button", { name: /pay now/i }) },
    { locator: page.getByRole("heading", { name: /payment details|payment gateway/i }) },
    { locator: page.getByText(/appointment (?:is )?confirmed|booking (?:is )?confirmed/i) },
  ], 100);
}

async function isPaymentStepReady(page) {
  if (!await waitForPortalNoticesClosed(page)) {
    return false;
  }
  return waitForAnyState([
    { locator: page.getByRole("button", { name: /pay now/i }) },
    { locator: page.getByRole("heading", { name: /payment details|payment gateway/i }) },
  ], 100);
}

async function waitForFileInputCount(page, expectedCount) {
  return waitForPortalStep(page, `Webfile input ${expectedCount}`, [
    { locator: page.locator(FILE_INPUT_SELECTOR).nth(expectedCount - 1), state: "attached" },
  ]);
}

export async function dismissPortalNotices(page) {
  const noticeTitles = [
    { label: "Important Notice", locator: page.getByText("Important Notice", { exact: true }) },
    { label: "Visa Undertaking advisory", locator: page.getByText(/Mandatory Submission of Visa Undertaking Form/i) },
    { label: "Fraudulent appointment advisory", locator: page.getByText(/Advisory on Fraudulent Visa Appointment Slot Offers/i) },
  ];
  let dismissedAny = false;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    let activeNotice = null;
    for (const notice of noticeTitles) {
      const count = await notice.locator.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = notice.locator.nth(index);
        if (await candidate.isVisible().catch(() => false)) {
          activeNotice = { ...notice, locator: candidate };
          break;
        }
      }
      if (activeNotice) {
        break;
      }
    }
    if (!activeNotice) {
      return dismissedAny;
    }

    const dialog = page.getByRole("dialog").filter({ has: activeNotice.locator });
    if (await dialog.count() === 1) {
      const namedClose = dialog.getByRole("button", { name: /close|dismiss/i });
      if (await namedClose.count() === 1 && await namedClose.isVisible().catch(() => false) && await namedClose.isEnabled().catch(() => false)) {
        await namedClose.click({ timeout: 3_000 }).catch(() => {});
        await activeNotice.locator.waitFor({ state: "hidden", timeout: 2_000 }).catch(() => {});
        if (!await activeNotice.locator.isVisible().catch(() => false)) {
          console.log(`Closed the ${activeNotice.label} modal.`);
          dismissedAny = true;
          await page.waitForTimeout(250);
          continue;
        }
      }
    }

    const closeInfo = await activeNotice.locator.evaluate((title) => {
      let ancestor = title;
      for (let depth = 0; ancestor && depth < 12; depth += 1, ancestor = ancestor.parentElement) {
        const controls = Array.from(ancestor.querySelectorAll("button, [role='button']"));
        const visibleControls = controls.filter((control) => {
          const rect = control.getBoundingClientRect();
          const style = getComputedStyle(control);
          return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        });
        const namedClose = visibleControls.filter((control) => /close|dismiss/i.test([
          control.getAttribute("aria-label") || "",
          control.getAttribute("title") || "",
          control.innerText || "",
        ].join(" ")));
        if (namedClose.length === 1) {
          return { depth, index: controls.indexOf(namedClose[0]) };
        }

        const ancestorRect = ancestor.getBoundingClientRect();
        const topRightClose = visibleControls.filter((control) => {
          const rect = control.getBoundingClientRect();
          return rect.width <= 80 && rect.height <= 80 &&
            rect.top <= ancestorRect.top + 80 &&
            rect.right >= ancestorRect.right - 80 &&
            rect.left >= ancestorRect.right - 100;
        });
        if (topRightClose.length === 1) {
          return { depth, index: controls.indexOf(topRightClose[0]) };
        }
      }
      return null;
    });

    if (!closeInfo) {
      console.warn(`${activeNotice.label} is open, but its close button was not uniquely identified. Close it manually in the browser.`);
      return dismissedAny;
    }

    let scope = activeNotice.locator;
    for (let depth = 0; depth < closeInfo.depth; depth += 1) {
      scope = scope.locator("xpath=..");
    }
    const controls = scope.locator("button, [role='button']");
    if (closeInfo.index >= await controls.count()) {
      console.warn(`${activeNotice.label} is open, but its close button could not be rebound safely.`);
      return dismissedAny;
    }

    const closeButton = controls.nth(closeInfo.index);
    if (!await closeButton.isVisible().catch(() => false) || !await closeButton.isEnabled().catch(() => false)) {
      console.warn(`${activeNotice.label} is open, but its close button is not available.`);
      return dismissedAny;
    }
    await closeButton.click({ timeout: 3_000 }).catch(() => {});
    await activeNotice.locator.waitFor({ state: "hidden", timeout: 2_000 }).catch(() => {});
    if (await activeNotice.locator.isVisible().catch(() => false)) {
      console.warn(`${activeNotice.label} is still open. Close it manually in the browser.`);
      return dismissedAny;
    }
    console.log(`Closed the ${activeNotice.label} modal.`);
    dismissedAny = true;
    await page.waitForTimeout(250);
  }

  for (const notice of noticeTitles) {
    if (await notice.locator.count() === 1 && await notice.locator.isVisible().catch(() => false)) {
      console.warn(`More IVAC notices remain open after repeated close attempts; close ${notice.label} manually.`);
      break;
    }
  }
  return dismissedAny;
}

async function getPdfPath(prompts, applicantLabel) {
  while (true) {
    const rawPath = (await prompts.question(`Path to ${applicantLabel} Webfile PDF: `)).trim();
    if (!rawPath) {
      console.log("No PDF path provided. Guided booking stopped.");
      return null;
    }

    const filePath = path.resolve(rawPath.replace(/^\"|\"$/g, "").replace(/^'|'$/g, ""));
    try {
      const fileInfo = await stat(filePath);
      if (!fileInfo.isFile() || path.extname(filePath).toLowerCase() !== ".pdf") {
        console.log("Choose a local .pdf file.");
        continue;
      }
      if (fileInfo.size > 500 * 1024) {
        console.log("The portal limit shown is 500 KB. Choose a smaller PDF.");
        continue;
      }

      const handle = await open(filePath, "r");
      let header;
      try {
        header = Buffer.alloc(5);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        if (bytesRead < 5 || header.toString("ascii") !== "%PDF-") {
          console.log("This file does not appear to be a PDF. Choose the original Webfile PDF.");
          continue;
        }
      } finally {
        await handle.close();
      }

      return { path: filePath, size: fileInfo.size, label: applicantLabel };
    } catch (error) {
      console.log(`Could not read that file: ${error.message}`);
    }
  }
}

function sortDocFilePdfs(entries) {
  const pdfEntries = entries.filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".pdf");
  const primary = pdfEntries.find((entry) => /^01(?:$|[\s._-])/i.test(entry.name));
  if (!primary) {
    return [];
  }

  const numberPrefix = (name) => {
    const match = name.match(/^\s*(\d+)(?=$|[\s._-])/);
    return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
  };
  const secondary = pdfEntries.filter((entry) => entry !== primary).sort((left, right) => {
    const difference = numberPrefix(left.name) - numberPrefix(right.name);
    return difference || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  });
  return [primary, ...secondary];
}

async function getDocFolderApplicants(docFolder, files) {
  const applicants = [];
  for (let index = 0; index < files.length; index += 1) {
    const filePath = path.join(docFolder, files[index].name);
    const label = index === 0 ? "Primary Applicant" : `Secondary Applicant ${index + 1}`;
    const fileInfo = await stat(filePath);
    if (fileInfo.size > 500 * 1024) {
      throw new Error(`${files[index].name} exceeds the portal's 500 KB limit.`);
    }
    const handle = await open(filePath, "r");
    let header;
    let bytesRead = 0;
    try {
      header = Buffer.alloc(5);
      ({ bytesRead } = await handle.read(header, 0, header.length, 0));
    } finally {
      await handle.close();
    }
    if (bytesRead < 5 || header.toString("ascii") !== "%PDF-") {
      throw new Error(`${files[index].name} does not appear to be a PDF.`);
    }
    applicants.push({ path: filePath, size: fileInfo.size, label });
  }
  return applicants;
}

async function getApplicantPdfs(prompts, { autoUseDocFolder = false, docFolder = DOC_FILE_DIR } = {}) {
  let detectedFiles = [];
  if (autoUseDocFolder) {
    let docFolderEntries = [];
    try {
      docFolderEntries = await readdir(docFolder, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.log(`Could not read ${docFolder}: ${error.message}`);
      }
    }
    detectedFiles = sortDocFilePdfs(docFolderEntries);
  }

  if (detectedFiles.length > 0) {
    console.log(`PDFs found in ${docFolder} (01 is Primary Applicant):`);
    detectedFiles.forEach((file, index) => console.log(`  ${index + 1}. ${file.name}`));
    if (detectedFiles.length > 4) {
      console.log("doc_file contains more than four PDFs. Keep only the applicants for this booking, then restart.");
      return null;
    }
    if (autoUseDocFolder || await askYesNo(prompts, `Use these ${detectedFiles.length} PDFs in this order?`)) {
      let applicants;
      try {
        applicants = await getDocFolderApplicants(docFolder, detectedFiles);
      } catch (error) {
        console.log(`Cannot use the PDFs in doc_file: ${error.message}`);
        return null;
      }
      console.log("Webfiles prepared in upload order:");
      applicants.forEach((applicant, index) => {
        console.log(`  ${index + 1}. ${applicant.label}: ${path.basename(applicant.path)} (${Math.ceil(applicant.size / 1024)} KB)`);
      });
      if (!autoUseDocFolder && !await askYesNo(
        prompts,
        `Upload these ${applicants.length} original PDF(s) to appointment.ivacbd.com? The portal says the Primary Webfile cannot be deleted or reuploaded once selected.`,
      )) {
        console.log("Webfile upload cancelled before selecting any file.");
        return null;
      }
      return applicants;
    }
  }

  if (autoUseDocFolder) {
    console.log("No Primary PDF starting with 01 was found in doc_file; guided upload stopped.");
    return null;
  }

  let applicantCount;
  while (true) {
    applicantCount = Number((await prompts.question("How many applicants are in this booking? (1-4): ")).trim());
    if (Number.isInteger(applicantCount) && applicantCount >= 1 && applicantCount <= 4) {
      break;
    }
    console.log("Enter a number from 1 to 4: one Primary Applicant and up to three Secondary Applicants.");
  }

  const applicants = [];
  const seenPaths = new Set();
  for (let index = 0; index < applicantCount; index += 1) {
    const applicantLabel = index === 0 ? "Primary Applicant" : `Secondary Applicant ${index + 1}`;
    const pdf = await getPdfPath(prompts, applicantLabel);
    if (!pdf) {
      return null;
    }
    const key = process.platform === "win32" ? pdf.path.toLowerCase() : pdf.path;
    if (seenPaths.has(key)) {
      console.log("Each applicant needs their own Webfile PDF. The same file cannot be selected twice.");
      index -= 1;
      continue;
    }
    seenPaths.add(key);
    applicants.push(pdf);
  }

  console.log("Webfiles prepared in upload order:");
  applicants.forEach((applicant, index) => {
    console.log(`  ${index + 1}. ${applicant.label}: ${path.basename(applicant.path)} (${Math.ceil(applicant.size / 1024)} KB)`);
  });
  if (!await askYesNo(
    prompts,
    `Upload these ${applicantCount} original PDF(s) to appointment.ivacbd.com? The portal says the Primary Webfile cannot be deleted or reuploaded once selected.`,
  )) {
    console.log("Webfile upload cancelled before selecting any file.");
    return null;
  }
  return applicants;
}

async function getFileInputDetails(page) {
  const inputs = page.locator(FILE_INPUT_SELECTOR);
  const count = await inputs.count();
  if (count === 0) {
    return [];
  }
  return inputs.evaluateAll((elements) => elements.map((element, index) => {
    const labels = element.labels ? Array.from(element.labels, (label) => label.innerText.trim()).filter(Boolean) : [];
    const name = element.getAttribute("name") || "";
    const id = element.id || "";
    let label = labels.join(" ") || element.getAttribute("aria-label") || "";

    // Check sibling label or dashed dropzone containing label (common in React/Tailwind portals)
    if (!label && element.previousElementSibling) {
      const sibling = element.previousElementSibling;
      const siblingLabel = sibling.querySelector("label") || (sibling.tagName === "LABEL" ? sibling : null);
      if (siblingLabel) {
        label = siblingLabel.innerText.trim();
      } else {
        const prevText = sibling.innerText || "";
        if (/upload\s+(?:primary|secondary|other|additional|applicant).*web\s*file|ওয়েবফাইল/i.test(prevText)) {
          label = prevText.trim();
        }
      }
    }
    if (!label && element.parentElement) {
      let ancestor = element.parentElement;
      for (let depth = 0; ancestor && depth < 4 && !label; depth += 1, ancestor = ancestor.parentElement) {
        const ancestorLabels = Array.from(ancestor.querySelectorAll("label"))
          .map((candidate) => candidate.innerText.trim())
          .filter(Boolean);
        const uploadLabels = ancestorLabels.filter((text) =>
          /upload.*(?:primary|secondary|other|additional|applicant).*web\s*file|ওয়েবফাইল/i.test(text),
        );
        if (uploadLabels.length === 1) {
          label = uploadLabels[0];
        } else if (ancestorLabels.length === 1 && ancestorLabels[0].length < 160) {
          label = ancestorLabels[0];
        }
      }
    }

    // Identify dangling/auxiliary hidden file inputs (e.g. inputs after action buttons without upload labels)
    // Only treat a post-confirmation hidden input as auxiliary.
    const isDangling = Boolean(
      element.previousElementSibling &&
      /confirm|নিশ্চিত/i.test(element.previousElementSibling.innerText || "")
    );

    if (!element.__ivacUploadInputIdentity) {
      window.__ivacUploadInputSequence = (window.__ivacUploadInputSequence || 0) + 1;
      element.__ivacUploadInputIdentity = `ivac-file-input-${window.__ivacUploadInputSequence}`;
    }

    return {
      index: index + 1,
      name,
      id,
      label,
      isDangling,
      disabled: Boolean(element.disabled),
      selected: Boolean(element.files && element.files.length),
      identity: element.__ivacUploadInputIdentity,
    };
  }));
}

async function chooseFileInput(page, prompts, applicantNumber, usedInputs) {
  // Case 1: Live IVAC dropzone inputs (direct proximity to .border-dashed)
  const dropzoneInputs = page.locator('.border-dashed + input[type="file"], [class*="border-dashed"] + input[type="file"], div:has(> [class*="border-dashed"]) input[type="file"]');
  const dropzoneCount = await dropzoneInputs.count().catch(() => 0);
  if (dropzoneCount === 1) {
    // Single reusable dropzone (Live IVAC)
    return {
      locator: dropzoneInputs.first(),
      identity: "ivac-single-dropzone-input",
    };
  }
  if (dropzoneCount > 1 && applicantNumber <= dropzoneCount) {
    // Multi-dropzone form (one dropzone per applicant)
    return {
      locator: dropzoneInputs.nth(applicantNumber - 1),
      identity: `ivac-dropzone-input-${applicantNumber}`,
    };
  }

  const inputLocator = page.locator(FILE_INPUT_SELECTOR);
  let details = await getFileInputDetails(page);
  const isPrimary = applicantNumber === 1;

  // Filter out dangling/auxiliary inputs (e.g. trailing inputs after confirm buttons)
  const nonDangling = details.filter((item) => !item.isDangling);

  // Case 2: Multi-input portal (e.g. separate file input slots or tests)
  const matchesApplicant = (item) => {
    if (item.isDangling) return false;
    const description = `${item.label} ${item.name} ${item.id}`;
    if (isPrimary) {
      return /primary|প্রাথমিক/i.test(description) || (!item.label && applicantNumber === 1);
    }
    if (/primary|প্রাথমিক/i.test(description)) return false;
    const explicitApplicant = description.match(/(?:secondary|applicant|web\s*file)\s*(?:applicant\s*)?(\d+)/i);
    if (explicitApplicant && Number(explicitApplicant[1]) !== applicantNumber) {
      return false;
    }
    return /secondary|other|additional|web\s*file|আবেদনকারী|ওয়েবফাইল/i.test(description);
  };

  const availableInputs = () => details.filter((item) =>
    !item.selected && !item.isDangling && (!usedInputs.has(item.identity) || matchesApplicant(item)),
  );
  let candidates = availableInputs();
  let labelledCandidates = candidates.filter(matchesApplicant);

  if (labelledCandidates.length === 1) {
    return { locator: inputLocator.nth(labelledCandidates[0].index - 1), identity: labelledCandidates[0].identity };
  }
  if (!isPrimary && labelledCandidates.length > 1) {
    const exactApplicant = labelledCandidates.filter((item) => {
      const description = `${item.label} ${item.name} ${item.id}`;
      const match = description.match(/(?:secondary|applicant|web\s*file)\s*(?:applicant\s*)?(\d+)/i);
      return match && Number(match[1]) === applicantNumber;
    });
    const unnumberedSecondary = labelledCandidates.filter((item) =>
      !/(?:secondary|applicant|web\s*file)\s*(?:applicant\s*)?\d+/i.test(`${item.label} ${item.name} ${item.id}`),
    );
    const selected = exactApplicant.length === 1 ? exactApplicant[0] : unnumberedSecondary[0];
    if (selected) {
      return { locator: inputLocator.nth(selected.index - 1), identity: selected.identity };
    }
  }

  const validNonDangling = candidates.filter((item) => !item.isDangling && (isPrimary || !/primary|প্রাথমিক/i.test(`${item.label} ${item.name} ${item.id}`)));
  if (isPrimary && validNonDangling.length === 1) {
    return { locator: inputLocator.nth(validNonDangling[0].index - 1), identity: validNonDangling[0].identity };
  }
  if (!isPrimary && validNonDangling.length >= 1 && labelledCandidates.length === 0) {
    return { locator: inputLocator.nth(validNonDangling[0].index - 1), identity: validNonDangling[0].identity };
  }

  if (!isPrimary && validNonDangling.length === 0) {
    const addApplicant = await findAddApplicantControl(page);
    if (addApplicant.found) {
      const previousInputCount = await inputLocator.count();
      if (!await clickPortalControl(page, addApplicant.locator, { timeout: 5_000 })) return null;
      if (!await waitForFileInputCount(page, previousInputCount + 1)) {
        console.log("Add Applicant was clicked, but a new Webfile input did not appear. Guided booking stopped.");
        return null;
      }
      details = await getFileInputDetails(page);
      candidates = availableInputs();
      labelledCandidates = candidates.filter(matchesApplicant);
      if (labelledCandidates.length === 1) {
        return { locator: inputLocator.nth(labelledCandidates[0].index - 1), identity: labelledCandidates[0].identity };
      }
      const freshNonDangling = candidates.filter((item) => !item.isDangling && !/primary|প্রাথমিক/i.test(`${item.label} ${item.name} ${item.id}`));
      if (freshNonDangling.length >= 1) {
        return { locator: inputLocator.nth(freshNonDangling[0].index - 1), identity: freshNonDangling[0].identity };
      }
    }
  }

  if (candidates.length === 1) {
    return { locator: inputLocator.nth(candidates[0].index - 1), identity: candidates[0].identity };
  }

  if (candidates.length > 1) {
    const validCandidates = candidates.filter((item) => !item.isDangling);
    const toShow = validCandidates.length > 0 ? validCandidates : candidates;
    if (toShow.length === 1) {
      return { locator: inputLocator.nth(toShow[0].index - 1), identity: toShow[0].identity };
    }
    console.log(`Choose the file input for applicant ${applicantNumber}:`);
    toShow.forEach((item, index) => console.log(`  ${index + 1}. ${item.label || item.name || item.id || `File input ${item.index}`}`));
    const answer = Number((await prompts.question("File input number: ")).trim());
    if (Number.isInteger(answer) && answer >= 1 && answer <= toShow.length) {
      const selected = toShow[answer - 1];
      return { locator: inputLocator.nth(selected.index - 1), identity: selected.identity };
    }
  }

  // Fallback for single non-dangling input
  if (nonDangling.length >= 1) {
    return { locator: inputLocator.nth(nonDangling[0].index - 1), identity: nonDangling[0].identity };
  }

  console.log(`No safe file input was identified for applicant ${applicantNumber}.`);
  return null;
}

async function waitForDateStep(page) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const url = page.url ? page.url() : "";
    if (/\/appointment\/(?:waiting|time-slot|declaration)/i.test(url)) {
      return true;
    }
    const pageText = await page.locator("body").innerText({ timeout: 500 }).catch(() => "");
    if (/(?:waiting for booking portal|no slots available at the moment)/i.test(pageText)) {
      return true;
    }
    const current = await detectPortalPage(page);
    if (["time-slot", "waiting", "declaration", "payment"].includes(current.key)) {
      return true;
    }
    if (await waitForAnyEnabled(page, [
      page.locator('input[type="date"]'),
      page.getByLabel(/appointment date/i),
      page.locator('[role="grid"] button'),
      page.locator("select"),
      page.locator('[role="combobox"]'),
      page.locator('button').filter({ hasText: /select appointment date|available dates|\b\d{1,2}:\d{2}\s*(?:am|pm)\b/i }),
    ], 200)) {
      return true;
    }
    await page.waitForTimeout(200);
  }
  return false;
}

async function handleWaitingRoomIfNeeded(page) {
  let url = page.url ? page.url() : "";
  let pageText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");

  if (url.includes("/appointment/waiting") || /(?:waiting for booking portal|no slots available at the moment)/i.test(pageText)) {
    log.waiting("Waiting Room: Portal is checking for slot release every 50 seconds...");

    let lastHeartbeat = 0;
    while (!page.isClosed()) {
      if (!await waitForPortalNoticesClosed(page, 2_000)) return false;
      url = page.url ? page.url() : "";
      pageText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");

      if (url.includes("/appointment/time-slot") || /(?:select appointment date|available slot|available dates|\b\d{1,2}:\d{2}\s*(?:am|pm)\b)/i.test(pageText)) {
        log.success("Slot window opened! Advanced to appointment time-slot selection.");
        return true;
      }

      const now = Date.now();
      if (now - lastHeartbeat >= 50_000) {
        const timerMatch = pageText.match(/(\d{1,2}\s*[hH]\s*\d{1,2}\s*[mM]\s*\d{1,2}\s*[sS]|\d{1,2}:\d{2}:\d{2})/);
        const timerInfo = timerMatch ? ` [Countdown: ${timerMatch[1]}]` : "";
        log.waiting(`Waiting Room: Still monitoring for slot opening...${timerInfo}`);
        lastHeartbeat = now;
      }
      await page.waitForTimeout(500).catch(() => {});
    }
  }
  return true;
}

async function selectSlotTimeIfPresent(page) {
  const slotButtons = page.locator('button').filter({ hasText: /\b(?:\d{1,2}:\d{2}\s*(?:AM|PM)|slot-\d+)\b/i });
  const count = await slotButtons.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const btn = slotButtons.nth(i);
    if (await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false)) {
      const slotText = (await btn.innerText().catch(() => "")).trim();
      log.step("Appointment Slot", `Selected: ${slotText}`);
      await clickPortalControl(page, btn, { timeout: 3_000 });
      break;
    }
  }
}

async function clickSlotContinueIfPresent(page) {
  const continueButtons = page.locator('button').filter({ hasText: /^(?:continue|proceed|next step|confirm slot|book slot)$/i });
  if (await continueButtons.count() > 0 && await continueButtons.first().isEnabled().catch(() => false)) {
    await clickPortalControl(page, continueButtons.first(), { timeout: 5_000 });
  }
}

const MISSION_CONFIRM_PATTERN = /confirm\s+mission\s*(?:&|and)\s*ivac\s+cent(?:re|er)/i;
const MISSION_PICKER_LABEL = /^select (?:a |your )?mission$/i;
const CENTRE_PICKER_LABEL = /^select (?:a |your )?ivac cent(?:re|er)$/i;

// The live /appointment/mission page uses custom dropdown buttons, not <select>.
// Each button holds a caption span ("Select your IVAC center") followed by the
// chosen value span ("IVAC, Dhaka (JFP)"). Returns that value, or null.
async function readPickerValue(page, captionPattern) {
  return page.locator('button[type="button"]').evaluateAll((buttons, source) => {
    const caption = new RegExp(source, "i");
    for (const button of buttons) {
      const texts = Array.from(button.querySelectorAll("span"))
        .map((span) => (span.innerText || span.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean);
      const index = texts.findIndex((text) => caption.test(text));
      if (index !== -1) {
        return texts[index + 1] || "";
      }
    }
    return null;
  }, captionPattern.source).catch(() => null);
}

async function findVisibleEnabled(locator) {
  const count = await locator.count().catch(() => 0);
  const matches = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false) && await candidate.isEnabled().catch(() => false)) {
      matches.push(candidate);
    }
  }
  return matches;
}

// Remembered Mission / IVAC Center choices, so the user is asked only once.
// One file per account when several accounts run side by side.
const PREFERENCES_USER = (process.env.IVAC_USER || "").trim() ? safeAccountName(process.env.IVAC_USER) : "";
const PREFERENCES_PATH = path.join(PROJECT_ROOT, PREFERENCES_USER ? `booking-preferences.${PREFERENCES_USER}.json` : "booking-preferences.json");

export async function loadBookingPreferences() {
  try {
    const value = JSON.parse(await readFile(PREFERENCES_PATH, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

async function saveBookingPreferences(preferences) {
  const clean = Object.fromEntries(Object.entries(preferences).filter(([, value]) => typeof value === "string" && value));
  await writeFile(PREFERENCES_PATH, `${JSON.stringify(clean, null, 2)}\n`, "utf8").catch(() => {});
}

// When no option could be read, keep the page HTML (scripts removed, field
// values and long digit runs blanked) so the dropdown structure can be studied.
async function saveDropdownSnapshot(page, kind) {
  const html = await page.evaluate(() => {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll("script, style, svg, template, [class*='marquee']").forEach((node) => node.remove());
    clone.querySelectorAll("input, textarea").forEach((node) => node.setAttribute("value", ""));
    return clone.outerHTML.replace(/\d{6,}/g, (digits) => `[${digits.length} digits]`);
  }).catch(() => "");
  if (!html) return;
  const dir = path.join(PROJECT_ROOT, "logs", "pages");
  await mkdir(dir, { recursive: true }).catch(() => {});
  const file = path.join(dir, `dropdown-${kind.replace(/\W+/g, "-").toLowerCase()}-${Date.now()}.html`);
  await writeFile(file, html, "utf8").catch(() => {});
  log.info(`Saved the ${kind} dropdown HTML to ${path.relative(PROJECT_ROOT, file)} for review.`);
}

// Opens one of the portal's custom dropdown buttons and picks an option. The
// option list only exists after the click, so the options are found as the
// clickable items that appeared because of the click. Picks the remembered
// choice, the only option, or asks the user to choose from a numbered list.
export async function chooseFromCustomDropdown(page, prompts, { caption, kind, preferred = "" }) {
  const trigger = page.locator('button[type="button"]').filter({
    has: page.locator("span", { hasText: caption }),
  }).first();
  if (await trigger.count().catch(() => 0) === 0) {
    log.warn(`Could not find the ${kind} dropdown.`);
    return null;
  }
  const enableDeadline = Date.now() + 15_000;
  while (!await trigger.isEnabled().catch(() => false) && Date.now() < enableDeadline) {
    await page.waitForTimeout(300).catch(() => {});
  }
  if (!await trigger.isEnabled().catch(() => false)) {
    log.warn(`The ${kind} dropdown did not become available.`);
    return null;
  }

  // Remember what was on screen before the click: the option list is either
  // created by the click or was already there but hidden.
  await page.evaluate(() => {
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
    };
    document.querySelectorAll("[data-ivac-opt]").forEach((node) => node.removeAttribute("data-ivac-opt"));
    document.querySelectorAll("body *").forEach((node) => node.setAttribute("data-ivac-seen", isVisible(node) ? "v" : "h"));
  });
  await clickPortalControl(page, trigger, { timeout: 5_000 });

  let options = [];
  const listDeadline = Date.now() + 8_000;
  while (options.length === 0 && Date.now() < listDeadline) {
    await page.waitForTimeout(300).catch(() => {});
    options = await page.evaluate(() => {
      const isVisible = (node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
      };
      // New, or previously hidden, elements that are visible now. Seen live:
      // the list is <div class="absolute z-50 ..."> next to the picker button,
      // and each option is itself a <button type="button"> ("IVAC, KHULNA").
      // The picker buttons were already visible before the click, so they are
      // excluded by data-ivac-seen; only the header and banner are skipped here.
      const fresh = Array.from(document.querySelectorAll("body *")).filter((node) =>
        node.getAttribute("data-ivac-seen") !== "v" && isVisible(node) &&
        !node.closest('[class*="marquee"], header'));
      const textOf = (node) => (node.innerText || "").replace(/\s+/g, " ").trim();
      const picks = [];
      const seenText = new Set();
      for (const node of fresh) {
        const text = textOf(node);
        if (!text || text.length > 80 || /^(?:select|choose|search|loading|no (?:data|options?|results?))\b/i.test(text)) continue;
        // Keep the innermost element for each option text.
        const innerSame = Array.from(node.querySelectorAll("*")).some((child) => textOf(child) === text);
        if (innerSame || seenText.has(text)) continue;
        // Skip containers that hold several options.
        if (Array.from(node.children).filter((child) => textOf(child)).length > 1) continue;
        if (node.disabled || node.getAttribute("aria-disabled") === "true") continue;
        seenText.add(text);
        node.setAttribute("data-ivac-opt", String(picks.length));
        picks.push(text);
      }
      return picks;
    }).catch(() => []);
  }
  await page.evaluate(() => document.querySelectorAll("[data-ivac-seen]").forEach((node) => node.removeAttribute("data-ivac-seen"))).catch(() => {});

  if (options.length === 0) {
    await saveDropdownSnapshot(page, kind);
    log.warn(`The ${kind} list did not open or has no options. Choose it in the browser.`);
    return null;
  }
  log.info(`${kind} options: ${options.join(" | ")}`);

  let index = -1;
  if (preferred) {
    index = options.findIndex((option) => option.toLowerCase() === preferred.toLowerCase());
    if (index === -1) index = options.findIndex((option) => option.toLowerCase().includes(preferred.toLowerCase()));
  }
  if (index === -1 && options.length === 1) {
    index = 0;
  }
  if (index === -1) {
    if (!prompts || typeof prompts.question !== "function") {
      log.warn(`More than one ${kind} is available; choose it in the browser.`);
      return null;
    }
    console.log(`Choose the ${kind}:`);
    options.forEach((option, optionIndex) => console.log(`  ${optionIndex + 1}. ${option}`));
    const answer = Number((await prompts.question(`${kind} number: `)).trim());
    if (!Number.isInteger(answer) || answer < 1 || answer > options.length) {
      log.warn(`No valid ${kind} was chosen.`);
      return null;
    }
    index = answer - 1;
  }

  const option = page.locator(`[data-ivac-opt="${index}"]`).first();
  if (!await clickPortalControl(page, option, { timeout: 5_000 })) {
    log.warn(`Could not click the ${kind} option "${options[index]}".`);
    return null;
  }
  await page.waitForTimeout(500).catch(() => {});
  const chosen = await readPickerValue(page, caption);
  if (!chosen || /^(?:select|choose|please select)\b/i.test(chosen)) {
    log.warn(`The ${kind} "${options[index]}" did not stay selected.`);
    return null;
  }
  log.step(kind, `Selected: ${chosen}`);
  return options[index];
}

// Handles the "Confirm Mission & IVAC Center" page. Returns undefined when the
// page is not shown, the confirmed centre label on success, or null on failure.
export async function confirmMissionAndCentre(page, timeout = 120_000, { prompts = null, preferences = null } = {}) {
  const confirmLocator = page.locator('button, [role="button"]').filter({ hasText: MISSION_CONFIRM_PATTERN });
  if (await confirmLocator.count().catch(() => 0) === 0) {
    return undefined;
  }

  log.step("IVAC Centre", "Mission & IVAC Center page detected");
  const isPlaceholder = (value) => !value || /^(?:select|choose|please select)\b/i.test(value);

  // Seen live: after a resumed booking the Mission is empty ("Select mission")
  // and the IVAC center says "Please select a mission first". Pick both.
  const prefs = preferences || await loadBookingPreferences();
  let prefsChanged = false;
  if (isPlaceholder(await readPickerValue(page, MISSION_PICKER_LABEL))) {
    const mission = await chooseFromCustomDropdown(page, prompts, {
      caption: MISSION_PICKER_LABEL, kind: "Mission", preferred: prefs.mission,
    });
    if (!mission) {
      return null;
    }
    prefsChanged = prefsChanged || prefs.mission !== mission;
    prefs.mission = mission;
    await page.waitForTimeout(800).catch(() => {});
  }
  if (isPlaceholder(await readPickerValue(page, CENTRE_PICKER_LABEL))) {
    const centreChoice = await chooseFromCustomDropdown(page, prompts, {
      caption: CENTRE_PICKER_LABEL, kind: "IVAC Center", preferred: prefs.centre,
    });
    if (centreChoice) {
      prefsChanged = prefsChanged || prefs.centre !== centreChoice;
      prefs.centre = centreChoice;
    }
  }
  if (!preferences && prefsChanged) {
    await saveBookingPreferences(prefs);
    log.info("Saved the Mission / IVAC Center choice in booking-preferences.json for next time.");
  }

  let centre = null;
  let promptedUser = false;
  const deadline = Date.now() + timeout;
  while (!page.isClosed() && Date.now() < deadline) {
    if (!await waitForPortalNoticesClosed(page, 2_000)) {
      return null;
    }
    centre = await readPickerValue(page, CENTRE_PICKER_LABEL);
    if (!isPlaceholder(centre)) {
      break;
    }
    if (!promptedUser) {
      log.action("Select your IVAC center in the browser; the helper will confirm it automatically.");
      promptedUser = true;
    }
    await page.waitForTimeout(500).catch(() => {});
  }
  if (isPlaceholder(centre)) {
    log.warn("No IVAC center was selected on the Mission page. Guided booking stopped.");
    return null;
  }

  const mission = await readPickerValue(page, MISSION_PICKER_LABEL);
  if (mission) {
    log.item("Mission", mission);
  }
  log.item("IVAC Centre", centre);

  if (!await waitForEnabledPortalStep(page, "Confirm Mission & IVAC Center", [confirmLocator], 30_000)) {
    log.warn("The Confirm Mission & IVAC Center button did not become available. Guided booking stopped.");
    return null;
  }
  const buttons = await findVisibleEnabled(confirmLocator);
  if (buttons.length !== 1) {
    log.warn(`Expected one Confirm Mission & IVAC Center button, found ${buttons.length}. Confirm it in the browser.`);
    return null;
  }

  log.step("IVAC Centre", "Clicking Confirm Mission & IVAC Center");
  if (!await clickPortalControl(page, buttons[0], { timeout: 5_000 })) {
    log.warn("Could not click Confirm Mission & IVAC Center. Guided booking stopped.");
    return null;
  }
  if (!await waitForDateStep(page)) {
    log.warn("Mission & IVAC Center was confirmed, but the appointment-date step did not appear. Guided booking stopped for review.");
    return null;
  }
  log.success(`Mission & IVAC Center confirmed: ${centre}.`);
  return centre;
}

async function chooseCentre(page, prompts) {
  const missionResult = await confirmMissionAndCentre(page, 120_000, { prompts });
  if (missionResult !== undefined) {
    return missionResult;
  }

  const selects = page.locator("select");
  const details = await selects.evaluateAll((elements) => elements.map((element, index) => {
    const labels = element.labels ? Array.from(element.labels, (label) => label.innerText.trim()).filter(Boolean) : [];
    return {
      index,
      name: element.getAttribute("name") || "",
      id: element.id || "",
      label: labels.join(" ") || element.getAttribute("aria-label") || "",
    };
  }));
  const centreMatches = details.filter((item) => /ivac.{0,20}cent(?:re|er)|cent(?:re|er).{0,20}ivac|mission/i.test(`${item.label} ${item.name} ${item.id}`));

  if (centreMatches.length >= 1 || (await selects.count()) === 1) {
    const select = selects.nth(centreMatches.length === 1 ? centreMatches[0].index : 0);
    const options = await select.locator("option").evaluateAll((elements) => elements.map((element) => ({
      label: element.label.trim(),
      value: element.value,
      disabled: element.disabled,
    })).filter((option) => !option.disabled && option.value && !/^(?:select|choose|please select)/i.test(option.label)));
    if (options.length > 0) {
      let selected;
      if (options.length === 1) {
        selected = options[0];
      } else {
        console.log("Eligible IVAC Centres:");
        options.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}`));
        const answer = Number((await prompts.question("Choose the preferred centre number: ")).trim());
        if (!Number.isInteger(answer) || answer < 1 || answer > options.length) {
          log.warn("No valid IVAC Centre was selected.");
          return null;
        }
        selected = options[answer - 1];
      }
      if (!await waitForPortalNoticesClosed(page)) {
        return null;
      }
      await select.selectOption({ value: selected.value });
      if (await select.inputValue() !== selected.value) {
        log.warn("The IVAC Centre selection did not remain selected. Guided booking stopped before date selection.");
        return null;
      }
      log.step("IVAC Centre", `Selected: ${selected.label}`);

      // If on /appointment/mission, click submit/continue button
      const nextBtn = page.locator('button').filter({ hasText: /^(?:next step|continue|proceed|submit)$/i });
      if (await nextBtn.count() > 0 && await nextBtn.first().isEnabled().catch(() => false)) {
        await clickPortalControl(page, nextBtn.first(), { timeout: 5_000 });
      }

      if (!await waitForDateStep(page)) {
        log.warn("The centre was selected, but the appointment-date step did not appear. Guided booking stopped for review.");
        return null;
      }
      return selected.label;
    }
  }

  // Check selectable centre cards / buttons
  const centreCards = page.locator('button, [role="button"], label').filter({
    hasText: /\b(dhaka|chittagong|sylhet|rajshahi|khulna|barisal|mymensingh|rangpur|cumilla|noakhali|brahmanbaria|satkhira|jashore|bogura|thakurgaon)\b/i,
  });
  const usableCentreCards = await findVisibleEnabled(centreCards);
  if (usableCentreCards.length === 1) {
    const cardText = (await usableCentreCards[0].innerText()).trim();
    log.step("IVAC Centre", `Selected: ${cardText}`);
    await clickPortalControl(page, usableCentreCards[0], { timeout: 3_000 });
    const nextBtn = page.locator('button').filter({ hasText: /^(?:next step|continue|proceed|submit)$/i });
    if (await nextBtn.count() > 0 && await nextBtn.first().isEnabled().catch(() => false)) {
      await clickPortalControl(page, nextBtn.first(), { timeout: 5_000 });
    }
    if (await waitForDateStep(page)) return cardText;
  }

  log.info("Select the preferred eligible IVAC Centre in the browser; waiting for the date selector to appear.");
  if (!await waitForDateStep(page)) {
    log.warn("The appointment-date step did not appear after centre selection. Guided booking stopped for review.");
    return null;
  }
  return (await prompts.question("Enter the selected centre name for the final review: ")).trim() || "Centre selected in browser";
}

const CONTINUE_BOOKING_PATTERN = /continue\s+booking/i;
const SLOTS_HELD_PATTERN = /slots? .{0,40}temporarily held|check back shortly/i;
const TRY_LATER_PATTERN = /wait a little longer|before trying again/i;

// The portal's toast notifications (top-right "Info" boxes). They disappear
// after a few seconds, so they are read right after an action.
export async function readPortalNotifications(page) {
  return page.locator('[data-sonner-toast], section[aria-label*="Notifications"] li, [role="region"][aria-label*="Notifications"] li, [role="status"], [role="alert"]')
    .evaluateAll((nodes) => nodes
      .map((node) => (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .map((text) => text.replace(/^Info\s*/i, "")))
    .catch(() => []);
}

async function findEnabledCalendarDays(page) {
  const dayButtons = page.locator('button[type="button"]').filter({ hasText: /^\s*\d{1,2}\s*$/ });
  return findVisibleEnabled(dayButtons);
}

async function readCalendarMonth(page) {
  return page.locator("span, h2, h3, div").filter({ hasText: /^\s*(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}\s*$/i })
    .first().innerText({ timeout: 1_000 }).then((text) => text.trim()).catch(() => "");
}

// Handles the live /appointment/time-slot calendar: picks a random enabled
// day, waits for Turnstile and clicks Continue Booking. Returns undefined when
// that page is not shown, the chosen date label on success, or null on failure.
export async function selectCalendarDateAndContinue(page, { random = Math.random, timeout = 60_000, retryFor = 20 * 60_000, retryEvery = 30_000 } = {}) {
  const continueLocator = page.locator('button, [role="button"]').filter({ hasText: CONTINUE_BOOKING_PATTERN });
  if (await continueLocator.count().catch(() => 0) === 0) {
    return undefined;
  }
  log.step("Appointment Date", "Calendar page detected");
  // Start the Cloudflare check early: it only runs once the widget is on screen.
  if (await scrollCaptchaIntoView(page)) {
    await page.waitForTimeout(800).catch(() => {});
  }

  let days = await findEnabledCalendarDays(page);
  for (let monthsAhead = 0; days.length === 0 && monthsAhead < 2; monthsAhead += 1) {
    const nextMonth = page.getByRole("button", { name: /next month/i });
    if (!await nextMonth.isEnabled().catch(() => false)) {
      break;
    }
    await clickPortalControl(page, nextMonth, { timeout: 3_000 });
    await page.waitForTimeout(400).catch(() => {});
    days = await findEnabledCalendarDays(page);
  }
  if (days.length === 0) {
    log.warn("No available appointment date is enabled in the calendar. Guided booking stopped.");
    return null;
  }

  const month = await readCalendarMonth(page);
  const dayTexts = await Promise.all(days.map((day) => day.innerText().then((text) => text.trim()).catch(() => "?")));
  log.info(`Available dates${month ? ` in ${month}` : ""}: ${dayTexts.join(", ")}`);
  const pick = Math.min(days.length - 1, Math.floor(random() * days.length));
  const label = `${dayTexts[pick]}${month ? ` ${month}` : ""}`;

  if (!await clickPortalControl(page, days[pick], { timeout: 3_000 })) {
    log.warn(`Could not click appointment date ${label}. Guided booking stopped.`);
    return null;
  }
  log.step("Appointment Date", `Selected (random): ${label}`);

  if (!await waitForCaptchaIfNeeded(page)) {
    return null;
  }
  if (!await waitForEnabledPortalStep(page, "Continue Booking", [continueLocator], timeout)) {
    log.warn("Continue Booking did not become enabled after the date was selected. Check the calendar in the browser.");
    return null;
  }
  // Seen live: before the slot booking period opens (the booking guide said
  // "Slot booking period will start from 05:00 PM") Continue Booking sends
  // nothing, shows no message, and only restarts the Cloudflare check. So the
  // click is retried, each time after Cloudflare has passed again.
  const retryDeadline = Date.now() + retryFor;
  let waitBetweenTries = retryEvery;
  const MAX_RETRY_WAIT_MS = Math.max(retryEvery, 120_000);
  for (let attempt = 1; !page.isClosed() && Date.now() < retryDeadline; attempt += 1) {
    if (attempt > 1) {
      if (!await waitForCaptchaIfNeeded(page)) {
        return null;
      }
      if (!await waitForEnabledPortalStep(page, "Continue Booking", [continueLocator], timeout)) {
        log.warn("Continue Booking did not become enabled again. Check the calendar in the browser.");
        return null;
      }
    }
    const buttons = await findVisibleEnabled(continueLocator);
    if (buttons.length !== 1) {
      log.warn(`Expected one Continue Booking button, found ${buttons.length}. Continue in the browser.`);
      return null;
    }
    log.step("Appointment Date", attempt === 1 ? "Clicking Continue Booking" : `Clicking Continue Booking (try ${attempt})`);
    if (!await clickPortalControl(page, buttons[0], { timeout: 5_000 })) {
      log.warn("Could not click Continue Booking. Guided booking stopped.");
      return null;
    }

    // Seen live: right after the click the button briefly changes while the
    // request runs, and then the page can stay on the date picker with "All
    // slots for this date are temporarily held...". So "moved on" means the
    // page itself is no longer the date picker, checked twice in a row.
    const stepDeadline = Date.now() + Math.min(timeout, 15_000);
    let leftCalendarChecks = 0;
    while (!page.isClosed() && Date.now() < stepDeadline) {
      await page.waitForTimeout(500).catch(() => {});
      const notices = await readPortalNotifications(page);
      if (notices.some((text) => SLOTS_HELD_PATTERN.test(text) || TRY_LATER_PATTERN.test(text))) {
        break;
      }
      const current = await detectPortalPage(page);
      if (current.key !== "time-slot") {
        leftCalendarChecks += 1;
        if (leftCalendarChecks >= 2) {
          log.success(`Booking continued with ${label}: ${current.label} is open.`);
          return label;
        }
        continue;
      }
      leftCalendarChecks = 0;
      const report = await reportVisibleIssues(page);
      if (report.issues.some(({ key }) => !["portal-alert", "slot-unavailable"].includes(key))) {
        log.warn("The portal reported a problem after Continue Booking. Check the browser.");
        return null;
      }
    }
    // Seen live (18 Nov 2026), in the portal's top-right "Info" notifications:
    //   "All slots for this date are temporarily held by users completing
    //    payment. Please check back shortly."
    //   "Please wait a little longer before trying again."  (clicked too often)
    const notices = await readPortalNotifications(page);
    const slotsHeld = notices.find((text) => SLOTS_HELD_PATTERN.test(text));
    const tooSoon = notices.find((text) => TRY_LATER_PATTERN.test(text));
    if (tooSoon) {
      waitBetweenTries = Math.min(waitBetweenTries * 2, MAX_RETRY_WAIT_MS);
      log.warn(`Portal: "${tooSoon}" Waiting ${Math.round(waitBetweenTries / 1000)} seconds before the next try.`);
    } else if (slotsHeld) {
      log.warn(`Portal: "${slotsHeld}" Trying again in ${Math.round(waitBetweenTries / 1000)} seconds.`);
    } else if (attempt === 1) {
      log.warn(`Continue Booking did not move on. The slot booking period may not be open yet (the portal's guide said 05:00 PM). Trying again every ${Math.round(waitBetweenTries / 1000)} seconds; press Ctrl+C to stop.`);
    }
    await page.waitForTimeout(waitBetweenTries).catch(() => {});
  }
  log.warn("Continue Booking never moved on to the next page. Guided booking stopped for review.");
  return null;
}

async function chooseDate(page, prompts) {
  // Check if portal is in the waiting room
  if (!await handleWaitingRoomIfNeeded(page)) return null;

  const calendarResult = await selectCalendarDateAndContinue(page);
  if (calendarResult !== undefined) {
    return calendarResult;
  }

  const waitForSubmitStep = () => waitForPortalStep(page, "consent or appointment-submit step", [
    { locator: page.locator('input[type="checkbox"]'), state: "visible" },
    { locator: page.getByRole("button", { name: /submit|confirm appointment|proceed to payment|continue/i }) },
    { locator: page.getByText(/terms and conditions|declaration|payment details/i) },
  ]);

  let date;
  while (true) {
    date = (await prompts.question("Preferred available date (YYYY-MM-DD) or press Enter for first available: ")).trim();
    if (!date) {
      break;
    }
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
    if (parsed && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date) {
      break;
    }
    console.log("Enter the date in YYYY-MM-DD format (or leave empty for first available slot).");
  }

  if (!await waitForPortalNoticesClosed(page)) return null;

  // Case 1: Standard input[type="date"]
  const dateInputs = page.locator('input[type="date"]');
  if (await dateInputs.count() === 1 && date) {
    await dateInputs.fill(date);
    if (await dateInputs.inputValue() === date) {
      log.step("Appointment Date", `Selected: ${date}`);
      await selectSlotTimeIfPresent(page);
      await waitForCaptchaIfNeeded(page);
      await clickSlotContinueIfPresent(page);
      if (await waitForSubmitStep()) return date;
    }
  }

  // Case 2: Date select dropdown (component LY)
  const dateSelect = page.locator("select").filter({ hasText: /\d{4}/ });
  if (await dateSelect.count() > 0) {
    const options = await dateSelect.first().locator("option").evaluateAll((elements) =>
      elements.map(e => ({ value: e.value, label: e.label.trim(), disabled: e.disabled }))
        .filter(o => !o.disabled && o.value && !/select|choose/i.test(o.label))
    );
    if (options.length > 0) {
      const match = date ? options.find(o => o.value.includes(date) || o.label.includes(date)) : null;
      const chosen = match || options[0];
      await dateSelect.first().selectOption({ value: chosen.value });
      log.step("Appointment Date", `Selected: ${chosen.label}`);
      await selectSlotTimeIfPresent(page);
      await waitForCaptchaIfNeeded(page);
      await clickSlotContinueIfPresent(page);
      if (await waitForSubmitStep()) return chosen.label;
    }
  }

  // Case 3: Calendar grid or day buttons
  if (date) {
    const [year, month, day] = date.split("-");
    const dayNumber = String(Number(day));
    const dayButton = page.getByRole("button", { name: dayNumber, exact: true });
    if (await dayButton.count() === 1 && await dayButton.isEnabled()) {
      if (await clickPortalControl(page, dayButton)) {
        log.step("Appointment Date", `Selected: ${date}`);
        await selectSlotTimeIfPresent(page);
        await waitForCaptchaIfNeeded(page);
        await clickSlotContinueIfPresent(page);
        if (await waitForSubmitStep()) return date;
      }
    }
  }

  // Case 4: Any available slot buttons
  const availableSlotButtons = page.locator('button').filter({ hasText: /\b(?:\d{1,2}:\d{2}\s*(?:AM|PM)|slot-\d+)\b/i });
  if (await availableSlotButtons.count() > 0) {
    const slotText = (await availableSlotButtons.first().innerText().catch(() => "")).trim();
    log.step("Appointment Slot", `Selected: ${slotText}`);
    await clickPortalControl(page, availableSlotButtons.first());
    await waitForCaptchaIfNeeded(page);
    await clickSlotContinueIfPresent(page);
    if (await waitForSubmitStep()) return date || "First available slot";
  }

  // Fallback: let user select in browser if custom calendar
  log.info("Select the preferred date and slot in the browser; waiting for next step...");
  if (!await waitForSubmitStep()) {
    log.warn("The consent/submit step did not appear after date selection. Guided booking stopped for review.");
    return null;
  }
  return date || "Selected in browser";
}

async function completeConsentIfNeeded(page, prompts) {
  const checkboxes = page.locator('input[type="checkbox"]');
  const details = await checkboxes.evaluateAll((elements) => elements.map((element, index) => {
    const labels = element.labels ? Array.from(element.labels, (label) => label.innerText.trim()).filter(Boolean) : [];
    return { index, label: labels.join(" ") || element.getAttribute("aria-label") || "" };
  }));
  const consent = details.filter((item) => /consent|agree|declaration/i.test(item.label));
  if (consent.length !== 1) {
    return true;
  }

  const checkbox = checkboxes.nth(consent[0].index);
  if (await checkbox.isChecked()) {
    return true;
  }
  if (!await askYesNo(prompts, "Do you agree to this consent and want the helper to select it?")) {
    log.warn("Consent was not selected. Guided booking stopped.");
    return false;
  }
  if (!await waitForPortalNoticesClosed(page)) return false;
  await checkbox.check();
  if (!await checkbox.isChecked()) {
    log.warn("The consent checkbox did not remain selected. Guided booking stopped before submission.");
    return false;
  }
  log.success("Terms & declaration consent confirmed.");
  return true;
}

// Cloudflare Turnstile on the portal only starts its check once the widget is
// on screen, and on the date picker it sits below the calendar. Scroll it into
// the middle of the viewport.
export async function scrollCaptchaIntoView(page) {
  return page.evaluate(() => {
    const response = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], textarea[name="g-recaptcha-response"]');
    const widget = document.querySelector("#cf-turnstile, .cf-turnstile, [data-sitekey], .g-recaptcha, iframe[src*='turnstile'], iframe[src*='captcha']") ||
      response?.closest("div");
    if (!widget) return false;
    widget.scrollIntoView({ block: "center", inline: "nearest" });
    return true;
  }).catch(() => false);
}

async function waitForCaptchaIfNeeded(page) {
  const captcha = page.locator(
    'iframe[title*="captcha" i], iframe[src*="captcha" i], iframe[src*="turnstile" i], .g-recaptcha, .cf-turnstile, #cf-turnstile, [data-sitekey], input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]',
  );
  if (await captcha.count() === 0) {
    return true;
  }
  await scrollCaptchaIntoView(page);
  log.action("Cloudflare check scrolled into view; waiting for it to pass (complete it in the browser if it asks)...");
  let lastHeartbeat = 0;
  let lastScroll = Date.now();
  while (!page.isClosed()) {
    if (!await waitForPortalNoticesClosed(page)) {
      return false;
    }
    if (Date.now() - lastScroll >= 5_000) {
      await scrollCaptchaIntoView(page);
      lastScroll = Date.now();
    }
    const solved = await page.locator('textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]')
      .evaluateAll((elements) => elements.some((element) => Boolean(element.value?.trim())))
      .catch(() => false);
    if (solved) {
      log.success("CAPTCHA response verified by portal.");
      return true;
    }
    const now = Date.now();
    if (now - lastHeartbeat >= 30_000) {
      await reportVisibleIssues(page);
      lastHeartbeat = now;
    }
    await page.waitForTimeout(300).catch(() => {});
  }
  return false;
}

const lastSuccessNoticesByPage = new WeakMap();

export function isSuccessNotice(text) {
  const value = String(text || "");
  return /\b(?:success(?:ful(?:ly)?)?|has been sent|sent to your|uploaded|saved|verified|confirmed)\b/i.test(value) &&
    !/\b(?:fail(?:ed|ure)?|error|invalid|incorrect|expired|denied|not (?:found|allowed|valid|available)|unable|too many)\b/i.test(value);
}

async function reportVisibleIssues(page) {
  let issues = [];
  const alertLocator = page.locator('[role="alert"], .alert, .text-red-500, [aria-live="assertive"], .toast');
  const alertCount = await alertLocator.count().catch(() => 0);
  if (alertCount > 0) {
    const visibleAlerts = [];
    for (let i = 0; i < alertCount; i++) {
      const el = alertLocator.nth(i);
      if (await el.isVisible().catch(() => false)) {
        const text = (await el.innerText().catch(() => "")).trim();
        if (text && !/^(?:\*|close|x)$/i.test(text)) {
          if (isSuccessNotice(text)) {
            // Seen live: "OTP sent successfully! A verification code has been
            // sent..." is a confirmation, not a problem; never stop the flow on it.
            const seen = lastSuccessNoticesByPage.get(page) || new Set();
            if (!seen.has(text)) {
              log.info(`Portal message: ${text.replace(/\s+/g, " ")}`);
              seen.add(text);
              lastSuccessNoticesByPage.set(page, seen);
            }
          } else {
            visibleAlerts.push(text);
          }
        }
      }
    }
    if (visibleAlerts.length > 0) {
      const combined = visibleAlerts.join(" ");
      issues = getPortalIssues(combined);
      if (issues.length === 0) {
        issues = [{ key: "portal-alert", label: combined, guidance: "Please check the browser." }];
      }
      const previousIssues = lastVisibleIssuesByPage.get(page) || new Set();
      const currentIssueKeys = new Set(issues.map(({ key }) => key));
      for (const issue of issues) {
        if (!previousIssues.has(issue.key)) {
          log.warn(`Portal Alert: ${issue.label}`);
        }
      }
      lastVisibleIssuesByPage.set(page, currentIssueKeys);
    }
  }

  const pageText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  return { pageText, issues, step: getPortalStep(pageText) };
}

function getApplicantCount(pageText) {
  const match = pageText.match(/total (?:number of )?applicants\s*:\s*(\d+)/i)
    || pageText.match(/applicants\s*:\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

// Seen live: re-uploading a Webfile the portal already holds from an earlier
// attempt is refused with HTTP 409 and the toast "File already exists.. Try
// again", while the page still shows "Total number of applicants: 0".
export const FILE_ALREADY_UPLOADED = "file-already-uploaded";
const FILE_ALREADY_EXISTS_PATTERN = /file already exists/i;

async function waitForApplicantCount(page, expectedCount, timeout = 60_000) {
  let lastHeartbeat = 0;
  const deadline = Date.now() + timeout;
  while (!page.isClosed() && Date.now() < deadline) {
    if (!await waitForPortalNoticesClosed(page, 2_000)) {
      return null;
    }
    const counterLocator = page.locator('p:has-text("Total number of applicants") span, div:has-text("Total number of applicants") span.text-orange, #applicant-count');
    let count = null;
    const counterCount = await counterLocator.count().catch(() => 0);
    if (counterCount > 0) {
      const text = (await counterLocator.first().innerText().catch(() => "")).trim();
      const numMatch = text.match(/\d+/);
      if (numMatch) {
        count = Number(numMatch[0]);
      }
    }
    const pageText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    if (FILE_ALREADY_EXISTS_PATTERN.test(pageText)) {
      return FILE_ALREADY_UPLOADED;
    }
    if (count === null) {
      count = getApplicantCount(pageText);
    }
    if (count !== null && count >= expectedCount) {
      return count;
    }
    const now = Date.now();
    if (now - lastHeartbeat >= 30_000) {
      await reportVisibleIssues(page);
      console.log(`Waiting for the portal to confirm Webfile ${expectedCount} of ${expectedCount}.`);
      lastHeartbeat = now;
    }
    await page.waitForTimeout(300).catch(() => {});
  }
  return null;
}

async function waitForApplicantSlotReady(page, applicantNumber, usedInputs, timeout = 35_000) {
  const isPrimary = applicantNumber === 1;
  const label = isPrimary ? "Primary Applicant" : `Secondary Applicant ${applicantNumber}`;
  const deadline = Date.now() + timeout;
  let lastHeartbeat = 0;
  let addAttempted = false;

  while (!page.isClosed() && Date.now() < deadline) {
    if (!await waitForPortalNoticesClosed(page, 2_000)) {
      return false;
    }

    // If secondary and an "Add Applicant" button exists (for multi-slot test mocks/portals), click it
    if (!isPrimary && !addAttempted) {
      const addControl = await findAddApplicantControl(page);
      if (addControl.found) {
        log.info(`Adding the upload slot for ${label}...`);
        if (await clickPortalControl(page, addControl.locator, { timeout: 5_000 })) {
          addAttempted = true;
          await page.waitForTimeout(400);
          continue;
        }
      }
    }

    // 1. Check Cloudflare Turnstile token readiness if Turnstile widget is present
    const turnstileInput = page.locator('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
    const hasTurnstile = await turnstileInput.count().catch(() => 0) > 0;
    let turnstileReady = true;
    if (hasTurnstile) {
      const val = await turnstileInput.first().inputValue().catch(() => "");
      turnstileReady = Boolean(val && val.trim().length > 0);
    }

    // 2. Check dropzone container loading state
    const dropzone = page.locator('.border-dashed, [class*="border-dashed"]').first();
    const hasDropzone = await dropzone.count().catch(() => 0) > 0;
    let isLoading = false;
    if (hasDropzone) {
      const dropzoneText = (await dropzone.innerText().catch(() => "")).toLowerCase();
      isLoading = dropzoneText.includes("loading");
    }

    // 3. Check file input disabled state
    const input = page.locator('.border-dashed + input[type="file"], [class*="border-dashed"] + input[type="file"], input[type="file"]').first();
    const hasInput = await input.count().catch(() => 0) > 0;
    let isDisabled = false;
    if (hasInput) {
      isDisabled = await input.isDisabled().catch(() => false);
    }

    // 4. For secondary applicants on live portal: verify previous applicants have been counted
    if (!isPrimary) {
      const currentPageText = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "");
      const currentCount = getApplicantCount(currentPageText);
      if (currentCount !== null && currentCount < applicantNumber - 1) {
        await page.waitForTimeout(300);
        continue;
      }
    }

    if (hasInput && !isDisabled && !isLoading && turnstileReady) {
      log.info(`Upload slot is ready for ${label}.`);
      return true;
    }

    const now = Date.now();
    if (now - lastHeartbeat >= 5_000) {
      if (!turnstileReady) {
        log.action(`Waiting for Cloudflare verification in browser for ${label}...`);
      } else if (isLoading || isDisabled) {
        log.info(`Waiting for portal dropzone to be ready for ${label}...`);
      }
      lastHeartbeat = now;
    }
    await page.waitForTimeout(300).catch(() => {});
  }

  // Fallback: if timeout reached but input exists, proceed
  const fallbackInput = page.locator(FILE_INPUT_SELECTOR).first();
  if (await fallbackInput.count().catch(() => 0) > 0) {
    log.info(`Proceeding with upload slot for ${label}.`);
    return true;
  }

  log.warn(`No ready upload slot appeared for ${label} within timeout.`);
  return false;
}

async function findConfirmModalSaveButton(page) {
  const candidates = [
    page.getByRole("button", { name: /save\s*&\s*continue|save\s+and\s+continue/i }),
    page.locator('button').filter({ hasText: /save\s*&\s*continue|save\s+and\s+continue/i }),
    page.locator('.fixed button, [role="dialog"] button, .modal button, div:has(> h2:has-text("confirm your details")) button').filter({ hasText: /save|continue|proceed/i }),
  ];

  for (const candidate of candidates) {
    const count = await candidate.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const btn = candidate.nth(i);
      if (await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false)) {
        return btn;
      }
    }
  }
  return null;
}

let lastUploadIssueKeys = [];

// Reloads the upload page and reads "Total number of applicants" as the
// server reports it. Returns the count, or null when it cannot be read.
async function recheckApplicantCountAfterReload(page, applicantLabel) {
  log.warn(`${applicantLabel}: the page did not show the upload. Reloading to check what the portal actually has.`);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
  await waitOutServerTrouble(page, { reason: "checking the uploaded Webfiles" });
  await dismissPortalNotices(page).catch(() => {});
  const deadline = Date.now() + 20_000;
  while (!page.isClosed() && Date.now() < deadline) {
    const text = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    const count = getApplicantCount(text);
    if (count !== null) {
      log.info(`After the reload the portal shows ${count} applicant(s).`);
      return count;
    }
    await page.waitForTimeout(500).catch(() => {});
  }
  return null;
}

// Reads the Primary Applicant the portal already holds, e.g. "SUMALA MONDAL"
// (seen live: "Primary Applicant\nSUMALA MONDAL\nUpload Other Applicant's Webfile").
export function readUploadedPrimaryName(pageText) {
  const match = String(pageText || "").match(/Primary Applicant[ \t]*\r?\n[ \t]*([^\r\n]{2,60})/);
  const name = match ? match[1].trim() : "";
  return name && !/upload|webfile|maximum|confirm/i.test(name) ? name : "";
}

// True unless the file name carries a person's name that differs from the
// portal's Primary (e.g. "01 BGDDW70BEF26PA690503 PARIMAL.pdf" vs "SUMALA MONDAL").
export function fileMatchesPerson(filePath, personName) {
  const words = path.basename(filePath, path.extname(filePath)).split(/[^A-Za-z]+/)
    .filter((word) => word.length >= 3 && !/\d/.test(word) && !/^bgd/i.test(word));
  if (words.length === 0) return true;
  const person = personName.toLowerCase();
  return words.some((word) => person.includes(word.toLowerCase()));
}

// Decides which PDFs still need uploading. Normally 01 is the Primary. When the
// portal already shows a different Primary, every PDF becomes another applicant.
export function planApplicantUploads(applicants, pageText) {
  const primaryName = readUploadedPrimaryName(pageText);
  if (!primaryName || applicants.length === 0 || fileMatchesPerson(applicants[0].path, primaryName)) {
    return { applicants, primaryOnPortal: "" };
  }
  return {
    primaryOnPortal: primaryName,
    applicants: [
      { path: null, size: 0, label: `Primary Applicant (${primaryName}, already on the portal)`, existing: true },
      ...applicants.map((applicant, index) => ({ ...applicant, label: `Other Applicant ${index + 2}` })),
    ],
  };
}

async function uploadApplicantPdfs(page, prompts, applicants, { autoConfirmApplicants = false } = {}) {
  lastUploadIssueKeys = [];
  const usedInputs = new Set();
  const currentPageText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  const alreadyUploaded = getApplicantCount(currentPageText) ?? 0;
  if (alreadyUploaded > applicants.length) {
    log.warn(`The portal already shows ${alreadyUploaded} applicants, but only ${applicants.length} PDFs were found in doc_file.`);
    return false;
  }
  if (alreadyUploaded > 0) {
    log.info(`The portal already shows ${alreadyUploaded} applicant(s); continuing with the next Webfile.`);
  }

  for (let index = alreadyUploaded; index < applicants.length; index += 1) {
    const applicant = applicants[index];
    const applicantNumber = index + 1;
    if (applicant.existing) {
      log.warn(`${applicant.label} is no longer shown on the portal. Check the upload page in the browser.`);
      return false;
    }
    log.step("Webfile Upload", `Preparing applicant ${applicantNumber} of ${applicants.length} (${applicant.label}): ${path.basename(applicant.path)}`);

    // Ensure slot is 100% ready (Turnstile verified, dropzone enabled, not loading) before attaching
    if (!await waitForApplicantSlotReady(page, applicantNumber, usedInputs)) {
      log.warn(`The portal was not ready to receive ${applicant.label}'s Webfile.`);
      return false;
    }

    const fileInput = await chooseFileInput(page, prompts, applicantNumber, usedInputs);
    if (!fileInput) {
      log.warn(`Could not safely identify a file input for ${applicant.label}.`);
      return false;
    }

    if (!await waitForPortalNoticesClosed(page)) return false;

    try {
      await fileInput.locator.setInputFiles(applicant.path);
    } catch (error) {
      log.warn(`Could not attach ${path.basename(applicant.path)} to the ${applicant.label} upload control: ${error.message}`);
      return false;
    }
    usedInputs.add(fileInput.identity);
    log.info(`Attached ${path.basename(applicant.path)}; waiting for the portal to confirm ${applicant.label}.`);

    const uploadControls = ["Upload Webfile", "Upload", "ওয়েবফাইল আপলোড"].map((name) =>
      page.getByRole("button", { name, exact: true })
    );
    for (const locator of uploadControls) {
      const count = await locator.count().catch(() => 0);
      for (let controlIndex = 0; controlIndex < count; controlIndex += 1) {
        const btn = locator.nth(controlIndex);
        if (await btn.isVisible().catch(() => false) && await btn.isEnabled().catch(() => false)) {
          log.info(`Clicking upload button for ${applicant.label}...`);
          await clickPortalControl(page, btn, { timeout: 5_000 });
          break;
        }
      }
    }

    let report = await reportVisibleIssues(page);
    if (FILE_ALREADY_EXISTS_PATTERN.test(report.pageText)) {
      // The server may already have this very file (an earlier attempt that
      // the page never showed). Ask the server before giving up on it.
      const serverCount = await recheckApplicantCountAfterReload(page, applicant.label);
      if (serverCount !== null && serverCount >= applicantNumber) {
        log.success(`Applicant ${applicantNumber} (${applicant.label}) is already on the portal. Count: ${serverCount}.`);
        continue;
      }
      return FILE_ALREADY_UPLOADED;
    }
    if (report.issues.length > 0) {
      lastUploadIssueKeys = report.issues.map(({ key }) => key);
      log.warn(`Resolve the portal message for ${applicant.label} before continuing.`);
      return false;
    }

    let acceptedCount = await waitForApplicantCount(page, applicantNumber);
    if (acceptedCount === FILE_ALREADY_UPLOADED) {
      const serverCount = await recheckApplicantCountAfterReload(page, applicant.label);
      if (serverCount !== null && serverCount >= applicantNumber) {
        log.success(`Applicant ${applicantNumber} (${applicant.label}) is already on the portal. Count: ${serverCount}.`);
        continue;
      }
      return FILE_ALREADY_UPLOADED;
    }
    report = await reportVisibleIssues(page);
    if (report.issues.length > 0) {
      lastUploadIssueKeys = report.issues.map(({ key }) => key);
      log.warn(`Resolve the portal message for ${applicant.label} before continuing.`);
      return false;
    }
    // Seen in practice: the PDF was uploaded but the page never showed it.
    // Reload and read the server's count before deciding it failed, so the
    // same file is never uploaded twice.
    if (acceptedCount === null || acceptedCount < applicantNumber) {
      const serverCount = await recheckApplicantCountAfterReload(page, applicant.label);
      if (serverCount !== null && serverCount >= applicantNumber) {
        acceptedCount = serverCount;
      } else {
        log.warn(`The portal shows ${serverCount ?? acceptedCount ?? "no"} applicant(s) after a reload, so ${applicant.label}'s upload did not reach the server.`);
        return false;
      }
    }
    log.success(`Applicant ${applicantNumber} (${applicant.label}) confirmed. Count: ${acceptedCount}.`);
  }

  const finalReport = await reportVisibleIssues(page);
  if (finalReport.issues.length > 0) {
    log.warn("Resolve the portal message before confirming applicant Webfiles.");
    return false;
  }
  const portalApplicantCount = getApplicantCount(finalReport.pageText);
  if (portalApplicantCount !== null && portalApplicantCount !== applicants.length) {
    log.warn(`The portal shows ${portalApplicantCount} applicant(s), but ${applicants.length} Webfile(s) were prepared.`);
    return false;
  }
  if (portalApplicantCount === null) {
    if (autoConfirmApplicants) {
      log.warn("The portal applicant count could not be read, so the helper will not confirm the Webfiles automatically.");
      return false;
    }
    if (!await askYesNo(prompts, `Does the portal show all ${applicants.length} applicants with their correct Webfiles?`)) {
      return false;
    }
  }

  // 1. Check if the "Please confirm your details" confirmation modal is already open
  let saveAndContinueBtn = await findConfirmModalSaveButton(page);

  if (!saveAndContinueBtn) {
    // Check if Turnstile is running on the Webfile page
    await waitForCaptchaIfNeeded(page);

    const confirmButton = await waitForUniqueControlUntilReady(
      page,
      ["button"],
      ["Confirm All Information is Correct"],
      "applicant confirmation",
      15_000,
    );
    if (!confirmButton.found) {
      // Re-check if Save & Continue appeared while waiting
      saveAndContinueBtn = await findConfirmModalSaveButton(page);
      if (!saveAndContinueBtn) {
        log.warn("Could not uniquely identify the applicant confirmation button. Review the page and confirm manually.");
        return false;
      }
    } else {
      if (!autoConfirmApplicants && !await askYesNo(
        prompts,
        `Confirm the ${applicants.length} applicant Webfiles are correct and continue? This saves the Primary Webfile, which the portal says cannot be deleted or reuploaded.`,
      )) {
        log.info("Applicant Webfile confirmation cancelled.");
        return false;
      }
      log.step("Confirm Applicants", "Confirming all applicant information with portal...");
      if (!await clickPortalControl(page, confirmButton.locator, { timeout: 5_000 })) return false;
    }
  }

  // 2. If Save & Continue was not already open, wait for the modal dialog to appear (up to 10s)
  if (!saveAndContinueBtn) {
    const modalDeadline = Date.now() + 10_000;
    while (!page.isClosed() && Date.now() < modalDeadline) {
      const isNextStep = await waitForAnyState([
        { locator: page.getByText(/select ivac cent(?:re|er)/i) },
        { locator: page.getByText(/select mission/i) },
        { locator: page.locator("select"), state: "visible" },
        { locator: page.locator('input[type="date"]'), state: "visible" },
        { locator: page.getByText(/appointment calendar|select appointment date/i) },
      ], 200);
      if (isNextStep) {
        break;
      }

      saveAndContinueBtn = await findConfirmModalSaveButton(page);
      if (saveAndContinueBtn) {
        break;
      }
      await page.waitForTimeout(200);
    }
  }

  // 3. Click Save & Continue if present
  if (saveAndContinueBtn) {
    log.step("Confirm Applicants", "Clicking 'Save & Continue' in confirmation dialog...");
    if (!await clickPortalControl(page, saveAndContinueBtn, { timeout: 8_000 })) {
      log.warn("Could not click Save & Continue button in confirmation dialog.");
      return false;
    }
    await page.waitForTimeout(400);
    const remainingModalBtn = await findConfirmModalSaveButton(page);
    if (remainingModalBtn && await remainingModalBtn.isVisible().catch(() => false)) {
      await clickPortalControl(page, remainingModalBtn, { timeout: 3_000, force: true }).catch(() => {});
    }
  }

  const bookingStepReady = await waitForPortalStep(page, "IVAC Centre/date selection", [
    { locator: page.getByText(/select (?:your )?ivac cent(?:re|er)/i) },
    { locator: page.locator('button, [role="button"]').filter({ hasText: MISSION_CONFIRM_PATTERN }) },
    { locator: page.locator('button, [role="button"]').filter({ hasText: CONTINUE_BOOKING_PATTERN }) },
    { locator: page.getByText(/select (?:an )?appointment date/i) },
    { locator: page.getByText(/select (?:a |your )?mission/i) },
    { locator: page.locator("select"), state: "visible" },
    { locator: page.locator('input[type="date"]'), state: "visible" },
    { locator: page.getByText(/appointment calendar|select appointment date/i) },
    { locator: page.locator('[role="combobox"]'), state: "visible" },
    { locator: page.getByRole("heading", { name: /select (?:ivac )?cent(?:re|er)|select mission|appointment details/i }) },
  ]);
  if (!bookingStepReady) {
    log.warn("Applicant confirmation was clicked, but the centre/date step did not appear.");
    return false;
  }
  log.success("Applicant Webfiles confirmed. Advancing to IVAC Centre selection.");
  return true;
}

async function clickNextStepIfPresent(page) {
  if (await isWebfileStepReady(page)) {
    return true;
  }
  const nextStep = await waitForUniqueControlUntilReady(
    page,
    ["button", "link"],
    ["Next Step"],
    "Next Step",
  );
  if (!nextStep.found) {
    return false;
  }
  if (!await clickPortalControl(page, nextStep.locator, { timeout: 5_000 })) return false;
  const uploadStepReady = await waitForPortalStep(page, "Webfile upload", [
    { locator: page.locator(FILE_INPUT_SELECTOR).first(), state: "attached" },
    { locator: page.getByText(/upload primary applicant(?:'s|’s) webfile/i) },
  ]);
  if (!uploadStepReady) {
    console.log("Next Step was clicked, but the Webfile upload step did not appear. Guided booking stopped for review.");
    return false;
  }
  console.log("Clicked Next Step to open the applicant Webfile upload page.");
  return true;
}

function loginInputMetadata(inputs) {
  return inputs.map((element, index) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const label = Array.from(element.labels || [])
      .map((item) => item.innerText || item.textContent || "")
      .join(" ");
    const prevText = element.previousElementSibling
      ? (element.previousElementSibling.innerText || element.previousElementSibling.textContent || "")
      : "";
    const parentText = element.parentElement
      ? (element.parentElement.innerText || element.parentElement.textContent || "")
      : "";
    return {
      index,
      type: (element.getAttribute("type") || "text").toLowerCase(),
      hint: [
        label,
        prevText,
        parentText,
        element.getAttribute("aria-label") || "",
        element.getAttribute("placeholder") || "",
        element.getAttribute("name") || "",
        element.id || "",
        element.getAttribute("autocomplete") || "",
      ].join(" ").replace(/\s+/g, " ").trim().toLowerCase(),
      visible: rect.width > 0 && rect.height > 0 &&
        style.visibility !== "hidden" && style.display !== "none",
      disabled: element.disabled,
      readOnly: element.readOnly,
    };
  });
}

function loginButtonMetadata(controls) {
  return controls.map((element, index) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      index,
      name: [
        element.innerText || element.textContent || "",
        element.getAttribute("aria-label") || "",
        element.getAttribute("value") || "",
      ].join(" ").replace(/\s+/g, " ").trim(),
      type: (element.getAttribute("type") || "").toLowerCase(),
      visible: rect.width > 0 && rect.height > 0 &&
        style.visibility !== "hidden" && style.display !== "none",
      disabled: Boolean(element.disabled),
    };
  });
}

async function typeIntoLoginField(page, locator, value) {
  if (!await waitForPortalNoticesClosed(page)) {
    return false;
  }
  await locator.click({ timeout: 5_000 });
  await locator.press("Control+A", { timeout: 5_000 });
  await locator.press("Backspace", { timeout: 5_000 });
  await locator.pressSequentially(value, { delay: 40, timeout: 15_000 });
  return await locator.inputValue() === value;
}

async function fillAndSubmitLogin(page, credentials) {
  await unblockInspectAndPaste(page);
  if (!await waitForPortalNoticesClosed(page, 3_000)) {
    return { fieldsFilled: false, submitted: false };
  }
  for (const frame of page.frames()) {
    const inputs = await frame.locator("input").evaluateAll(loginInputMetadata).catch(() => []);
    const available = inputs.filter((input) => input.visible && !input.disabled && !input.readOnly);
    const passwordMatches = available.filter((input) => input.type === "password");
    if (passwordMatches.length !== 1) {
      continue;
    }

    const textInputs = available.filter((input) =>
      ["text", "tel", "number", "email"].includes(input.type),
    );
    const contactHints = textInputs.filter((input) =>
      /contact|mobile|phone|login\s*(?:id|name)?|user\s*(?:id|name)?|username/.test(input.hint),
    );
    let contactMatch = null;
    if (contactHints.length === 1) {
      contactMatch = contactHints[0];
    } else if (contactHints.length > 1) {
      continue;
    } else {
      const telInputs = textInputs.filter((input) => input.type === "tel");
      if (telInputs.length === 1) {
        contactMatch = telInputs[0];
      } else if (textInputs.length === 1) {
        contactMatch = textInputs[0];
      } else {
        continue;
      }
    }

    const contactField = frame.locator("input").nth(contactMatch.index);
    const passwordField = frame.locator("input").nth(passwordMatches[0].index);
    const containingForms = frame.locator("form").filter({ has: passwordField });
    const formCount = await containingForms.count().catch(() => 0);
    const scope = formCount === 1 ? containingForms : frame;
    const buttons = await scope.locator('button, [role="button"], input[type="submit"]')
      .evaluateAll(loginButtonMetadata).catch(() => []);
    const visibleButtons = buttons.filter((button) => button.visible);
    const namedButtons = visibleButtons.filter((button) =>
      /sign\s*in|log\s*in|login/i.test(button.name),
    );
    let submitIndex = null;
    if (namedButtons.length === 1) {
      submitIndex = namedButtons[0].index;
    } else if (namedButtons.length === 0 && formCount === 1) {
      const submitButtons = visibleButtons.filter((button) => button.type === "submit");
      if (submitButtons.length === 1) {
        submitIndex = submitButtons[0].index;
      }
    }
    if (submitIndex === null) {
      continue;
    }

    const submitButton = scope.locator('button, [role="button"], input[type="submit"]').nth(submitIndex);
    try {
      const contactFilled = await setLoginInputValue(page, contactField, credentials.contactNumber);
      if (!contactFilled) {
        log.warn("The contact-number field did not retain the typed value. Sign In was not clicked.");
        return { fieldsFilled: false, submitted: false };
      }
      const passwordFilled = await setLoginInputValue(page, passwordField, credentials.password);
      if (!passwordFilled) {
        log.warn("The password field did not retain the typed value. Sign In was not clicked.");
        return { fieldsFilled: false, submitted: false };
      }

      log.step("Sign In", "Entered contact number and password");
      let enabled = await submitButton.isEnabled().catch(() => false);
      let lastHeartbeat = 0;
      // Cloudflare can take minutes to pass when the portal is busy.
      const enableDeadline = Date.now() + 5 * 60_000;
      if (!enabled) {
        log.action("Credentials filled. Complete Cloudflare / CAPTCHA in browser to enable Sign In...");
        while (!page.isClosed() && Date.now() < enableDeadline) {
          if (!await waitForPortalNoticesClosed(page, 2_000)) {
            return { fieldsFilled: false, submitted: false };
          }
          const pageText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
          if (await isOtpPageVisible(page, pageText) ||
            (!await isAuthenticationPageVisible(page, pageText) && await isBookingSurfaceReady(page))) {
            return { fieldsFilled: true, submitted: true };
          }
          await page.waitForTimeout(300);
          enabled = await submitButton.isEnabled().catch(() => false);
          if (enabled) {
            break;
          }
          const now = Date.now();
          if (now - lastHeartbeat >= 30_000) {
            await reportVisibleIssues(page);
            lastHeartbeat = now;
          }
        }
      }

      if (!enabled) {
        return { fieldsFilled: true, submitted: false };
      }

      if (!await clickPortalControl(page, submitButton, { timeout: 5_000 })) {
        return { fieldsFilled: true, submitted: false };
      }
      log.success("Clicked Sign In Now.");
      return { fieldsFilled: true, submitted: true };
    } catch (error) {
      log.warn("Automatic sign-in could not complete: " + error.message);
      return { fieldsFilled: false, submitted: false };
    }
  }

  const frameDiagnostics = await Promise.all(page.frames().map(async (frame) => {
    const inputs = await frame.locator("input").evaluateAll(loginInputMetadata).catch(() => []);
    const buttons = await frame.locator('button, [role="button"], input[type="submit"]')
      .evaluateAll(loginButtonMetadata).catch(() => []);
    let safeUrl = "";
    try {
      const parsed = new URL(frame.url());
      safeUrl = parsed.origin + parsed.pathname;
    } catch {
      safeUrl = "unavailable";
    }
    return {
      url: safeUrl,
      inputs: inputs.map(({ index, type, hint, visible, disabled, readOnly }) => ({
        index, type, hint, visible, disabled, readOnly,
      })),
      signInControls: buttons.filter(({ name }) => /sign\s*in|log\s*in|login/i.test(name))
        .map(({ name, visible, disabled, type }) => ({ name, visible, disabled, type })),
    };
  }));
  console.warn("Could not identify the login controls. Safe field diagnostics (input values omitted): " + JSON.stringify(frameDiagnostics));
  return { fieldsFilled: false, submitted: false };
}
function isOtpPage(pageText) {
  return /(?:verify otp|otp verification|enter (?:the )?otp)/i.test(pageText);
}

function isAuthenticationPage(pageText) {
  return isOtpPage(pageText) || /(?:enter your password|sign in now|one[- ]time password|verification code)/i.test(pageText);
}

async function isOtpPageVisible(page, pageText) {
  if (isOtpPage(pageText)) return true;
  // Seen live: /verify-login-phone-otp with six boxes #otp-0 ... #otp-5.
  try {
    if (/\/verify-[\w-]*otp/i.test(new URL(page.url()).pathname)) return true;
  } catch {}
  return await page.locator('#otp-0, input[autocomplete="one-time-code"]').first().isVisible().catch(() => false);
}

async function isAuthenticationPageVisible(page, pageText) {
  if (isAuthenticationPage(pageText)) {
    return true;
  }
  for (const frame of page.frames()) {
    if (await frame.locator('input[type="password"]').isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function isBookingSurfaceReady(page) {
  return waitForAnyState([
    { locator: page.getByRole("button", { name: "Take Your Appointment", exact: true }) },
    { locator: page.getByRole("link", { name: "Take Your Appointment", exact: true }) },
    { locator: page.getByRole("button", { name: "Next Step", exact: true }) },
    { locator: page.getByRole("link", { name: "Next Step", exact: true }) },
    { locator: page.getByRole("button", { name: /book your appointment|book appointment/i }) },
    { locator: page.getByRole("link", { name: /book your appointment|book appointment/i }) },
    { locator: page.locator(FILE_INPUT_SELECTOR).first(), state: "attached" },
    { locator: page.getByLabel(/select ivac cent(?:re|er)/i) },
    { locator: page.locator('input[type="date"]'), state: "visible" },
    { locator: page.getByRole("button", { name: /pay now/i }) },
    { locator: page.getByRole("button", { name: /log\s*out/i }) },
    { locator: page.getByRole("link", { name: /log\s*out/i }) },
  ], 100);
}

export async function isAlreadyLoggedIn(page) {
  const logoutBtn = page.getByRole("button", { name: /log\s*out/i });
  const logoutLnk = page.getByRole("link", { name: /log\s*out/i });
  if ((await logoutBtn.count().catch(() => 0)) > 0 || (await logoutLnk.count().catch(() => 0)) > 0) {
    return true;
  }
  const url = page.url ? page.url() : "";
  if (/\/to-book-visa-appointment|\/appointment\//i.test(url)) {
    return true;
  }
  const pageText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
  if (/(?:to book your visa appointment|total (?:number of )?applicants)/i.test(pageText)) {
    return true;
  }
  return false;
}

// The "press Enter when done" prompt is optional: the page usually finishes
// sign-in on its own. readline drops any question asked while another is still
// pending, so the unanswered prompt must be cancelled before returning, or every
// later question (date, centre, final submit) would never resolve.
async function waitForOtpOrAuth(page, prompts, promptMessage, timeout = 15 * 60_000) {
  let promptDone = false;
  const promptAbort = new AbortController();
  if (prompts && typeof prompts.question === "function") {
    Promise.resolve()
      .then(() => prompts.question(promptMessage, { signal: promptAbort.signal }))
      .then(() => {
        promptDone = true;
      })
      .catch(() => {
        promptDone = true;
      });
  }

  try {
    return await pollOtpOrAuth(page, promptMessage, () => promptDone, timeout);
  } finally {
    if (!promptDone) {
      promptAbort.abort();
      process.stdout.write("\n");
    }
  }
}

// Where an OTP can come from besides the browser itself (the control panel).
// { take(): string | null, request(details): void }
let otpProvider = null;
export function setOtpProvider(provider) {
  otpProvider = provider || null;
}

// Fills the portal's OTP and clicks Verify OTP. Seen live: the OTP page has
// six one-digit boxes (#otp-0 ... #otp-5) and Verify OTP stays disabled until
// all are filled. A single OTP field is handled as a fallback.
export async function fillOtpAndVerify(page, code) {
  const digits = String(code).replace(/\D/g, "");
  if (!digits) return false;
  const boxes = page.locator('input[id^="otp-"][maxlength="1"]');
  const boxCount = await boxes.count().catch(() => 0);
  if (boxCount >= digits.length) {
    for (let index = 0; index < digits.length; index += 1) {
      const box = page.locator(`#otp-${index}`);
      await box.click({ timeout: 3_000 }).catch(() => {});
      await box.fill("").catch(() => {});
      await box.pressSequentially(digits[index], { delay: 40, timeout: 3_000 }).catch(() => {});
    }
  } else {
    const single = page.locator('input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i]').first();
    if (!await single.isVisible().catch(() => false)) return false;
    await single.click({ timeout: 3_000 }).catch(() => {});
    await single.fill("").catch(() => {});
    await single.pressSequentially(digits, { delay: 40, timeout: 5_000 }).catch(() => {});
  }
  const verify = page.locator('button, [role="button"]').filter({ hasText: /verify\s*otp/i }).first();
  const enableDeadline = Date.now() + 10_000;
  while (Date.now() < enableDeadline && !await verify.isEnabled().catch(() => false)) {
    await page.waitForTimeout(200).catch(() => {});
  }
  if (!await verify.isEnabled().catch(() => false)) {
    log.warn("Verify OTP did not become active after filling the OTP. Check the boxes in the browser.");
    return false;
  }
  log.step("OTP", "Entered the OTP from the control panel; clicking Verify OTP");
  return clickPortalControl(page, verify, { timeout: 5_000 });
}

async function pollOtpOrAuth(page, promptMessage, isPromptDone, timeout) {
  const started = Date.now();
  let deadline = Date.now() + timeout;
  let lastHeartbeat = 0;
  let lastTroubleCheck = 0;
  let otpRequested = false;
  const reportedRejections = new Set();
  while (!page.isClosed() && Date.now() < deadline) {
    // From the control panel: ask for the OTP once the OTP page is open, and
    // fill it in as soon as it arrives.
    if (otpProvider) {
      const onOtpPage = await isOtpPageVisible(page, "");
      if (onOtpPage && !otpRequested) {
        otpRequested = true;
        otpProvider.request({ path: (() => { try { return new URL(page.url()).pathname; } catch { return ""; } })() });
        log.action("Waiting for the OTP: type it in the control panel (or directly in the browser).");
      }
      const code = onOtpPage ? otpProvider.take() : null;
      if (code) {
        await fillOtpAndVerify(page, code);
        await page.waitForTimeout(1_500).catch(() => {});
      }
    }
    // Seen in practice: the OTP SMS can take minutes when the portal is busy.
    // Keep waiting (never resend automatically: a new code cancels the old
    // one), tell the user if the portal rejects the code, and ride out
    // overloaded-server pages.
    const notices = await readPortalNotifications(page);
    for (const text of notices) {
      if (OTP_REJECTED_PATTERN.test(text) && !reportedRejections.has(text)) {
        reportedRejections.add(text);
        log.action(`The portal rejected the OTP: "${text}". Request a new code with Resend OTP in the browser, then enter the newest code.`);
        otpProvider?.request({ rejected: text });
      }
    }
    if (Date.now() - lastTroubleCheck >= 5_000) {
      lastTroubleCheck = Date.now();
      const trouble = await detectServerTrouble(page);
      if (trouble && trouble.scope === "page") {
        await waitOutServerTrouble(page, { reason: "waiting for the OTP" });
        deadline = Math.max(deadline, Date.now() + 5 * 60_000);
        continue;
      }
    }
    if (!await waitForPortalNoticesClosed(page, 2_000)) {
      return "closed";
    }
    const pageText = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "");

    const isOtp = await isOtpPageVisible(page, pageText);
    if (isOtp && !promptMessage.toLowerCase().includes("enter the otp")) {
      return "otp";
    }

    if (!await isAuthenticationPageVisible(page, pageText) && (await isBookingSurfaceReady(page) || await isAlreadyLoggedIn(page))) {
      return "authenticated";
    }

    if (isPromptDone()) {
      await page.waitForTimeout(200);
      const textAfter = await page.locator("body").innerText({ timeout: 1_000 }).catch(() => "");
      if (await isOtpPageVisible(page, textAfter)) {
        return "otp";
      }
      if (!await isAuthenticationPageVisible(page, textAfter) && (await isBookingSurfaceReady(page) || await isAlreadyLoggedIn(page))) {
        return "authenticated";
      }
    }

    const now = Date.now();
    if (now - lastHeartbeat >= 30_000) {
      await reportVisibleIssues(page);
      const waited = Math.floor((now - started) / 1000);
      const minutes = Math.floor(waited / 60);
      const seconds = waited % 60;
      console.log(`Waiting for the OTP to be entered and verified (${minutes}m ${seconds}s). If the SMS is late, keep waiting; use Resend OTP in the browser only if the portal offers it.`);
      lastHeartbeat = now;
    }
    await page.waitForTimeout(300).catch(() => {});
  }
  return "closed";
}

// After Sign In Now: waits for the OTP page or the logged-in portal. Under
// heavy load the portal can (seen in practice) answer slowly, send the OTP but
// stay on /signin, or rate-limit. Clicking Sign In again sends a new OTP and
// counts against the limit, so it is clicked again only after a long silence.
const OTP_PAGE_PATH = "/verify-login-phone-otp";
const SIGN_IN_SILENCE_BEFORE_RECLICK_MS = 90_000;
const MAX_SIGN_IN_RECLICKS = 2;
const OTP_SENT_BUT_STUCK_MS = 20_000;

async function waitForAuthenticationOutcome(page, afterOtp = false, timeout = 10 * 60_000) {
  let lastHeartbeat = 0;
  let sawAlert = false;
  const started = Date.now();
  let deadline = Date.now() + timeout;
  let lastActivity = Date.now();
  let otpSentAt = 0;
  let triedOtpPageDirectly = false;
  let reclicks = 0;
  let lastTroubleCheck = 0;
  while (!page.isClosed() && Date.now() < deadline) {
    if (!await waitForPortalNoticesClosed(page, 2_000)) {
      return "closed";
    }
    const pageText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
    const otpPageVisible = await isOtpPageVisible(page, pageText);
    if (!afterOtp && otpPageVisible) {
      return "otp";
    }
    if (!await isAuthenticationPageVisible(page, pageText) && (await isBookingSurfaceReady(page) || await isAlreadyLoggedIn(page))) {
      return "authenticated";
    }

    const now = Date.now();
    const notices = await readPortalNotifications(page);
    if (!afterOtp && !otpSentAt && notices.some((text) => OTP_SENT_PATTERN.test(text))) {
      otpSentAt = now;
      lastActivity = now;
    }
    // Seen in practice: "OTP sent" appears but the OTP input page never opens.
    if (!afterOtp && otpSentAt && !triedOtpPageDirectly && now - otpSentAt >= OTP_SENT_BUT_STUCK_MS && !otpPageVisible) {
      triedOtpPageDirectly = true;
      log.warn("The portal sent the OTP but did not open the OTP page. Opening the OTP page directly.");
      const origin = new URL(page.url()).origin;
      await gotoWithRecovery(page, `${origin}${OTP_PAGE_PATH}`, { attempts: 3 });
      await page.waitForTimeout(1_500).catch(() => {});
      const textAfter = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
      if (await isOtpPageVisible(page, textAfter)) {
        log.success("OTP page opened. Enter the OTP you received.");
        return "otp";
      }
      log.warn("The OTP page did not open directly. Enter the OTP if an input appears, or click Sign In Now again in the browser.");
    }

    // An overloaded or rate-limited portal: wait it out instead of clicking.
    if (now - lastTroubleCheck >= 5_000) {
      lastTroubleCheck = now;
      const trouble = await detectServerTrouble(page);
      if (trouble) {
        await waitOutServerTrouble(page, { reason: "signing in" });
        lastActivity = Date.now();
        deadline = Math.max(deadline, Date.now() + 2 * 60_000);
        continue;
      }
    }

    // Nothing happened for a long time after Sign In: click it once more.
    if (!afterOtp && !otpSentAt && reclicks < MAX_SIGN_IN_RECLICKS && now - lastActivity >= SIGN_IN_SILENCE_BEFORE_RECLICK_MS) {
      const signInButton = page.locator('button, [role="button"], input[type="submit"]').filter({ hasText: /sign\s*in\s*now/i }).first();
      if (await signInButton.isVisible().catch(() => false) && await signInButton.isEnabled().catch(() => false)) {
        reclicks += 1;
        log.warn(`No answer from the portal ${Math.round((now - lastActivity) / 1000)}s after Sign In. Clicking Sign In Now again (${reclicks} of ${MAX_SIGN_IN_RECLICKS}).`);
        await clickPortalControl(page, signInButton, { timeout: 5_000 });
      }
      lastActivity = Date.now();
    }
    if (!sawAlert && await page.getByRole("alert").isVisible().catch(() => false)) {
      console.warn("The portal displayed an authentication alert. Resolve it in the browser; the helper is waiting for the next page state.");
      sawAlert = true;
    }
    if (now - lastHeartbeat >= 30_000) {
      await reportVisibleIssues(page);
      const waited = Math.round((now - started) / 1000);
      console.log(afterOtp
        ? `Waiting for OTP verification to finish and the authenticated booking page to appear (${waited}s).`
        : `Waiting for the sign-in result: OTP verification or the authenticated booking page (${waited}s; the portal can be slow when busy).`);
      lastHeartbeat = now;
    }
    await page.waitForTimeout(300).catch(() => {});
  }
  return "closed";
}

async function waitForBookingNavigation(page, label) {
  let lastHeartbeat = 0;
  while (!page.isClosed()) {
    if (!await waitForPortalNoticesClosed(page)) {
      return { type: "closed" };
    }
    if (await isWebfileStepReady(page)) {
      return { type: "webfile" };
    }
    const nextStep = await findUniqueControl(page, ["button", "link"], ["Next Step"]);
    if (nextStep.found || nextStep.ambiguous) {
      return { type: "next", control: nextStep };
    }
    const bookingEntry = await findUniqueControl(page, ["button", "link"], ["Book Your Appointment", "Book appointment"]);
    if (bookingEntry.found || bookingEntry.ambiguous) {
      return { type: "book", control: bookingEntry };
    }
    const now = Date.now();
    if (now - lastHeartbeat >= 30_000) {
      await reportVisibleIssues(page);
      console.log(`Still waiting for the ${label} page/control to become ready.`);
      lastHeartbeat = now;
    }
    await page.waitForTimeout(300).catch(() => {});
  }
  return { type: "closed" };
}

async function waitForNextOrWebfile(page, label) {
  let lastHeartbeat = 0;
  while (!page.isClosed()) {
    if (!await waitForPortalNoticesClosed(page)) {
      return { type: "closed" };
    }
    if (await isWebfileStepReady(page)) {
      return { type: "webfile" };
    }
    const nextStep = await findUniqueControl(page, ["button", "link"], ["Next Step"]);
    if (nextStep.found || nextStep.ambiguous) {
      return { type: "next", control: nextStep };
    }
    const now = Date.now();
    if (now - lastHeartbeat >= 30_000) {
      await reportVisibleIssues(page);
      console.log(`Still waiting for ${label}.`);
      lastHeartbeat = now;
    }
    await page.waitForTimeout(300).catch(() => {});
  }
  return { type: "closed" };
}

const PORTAL_PAGES = {
  closed: "Browser closed",
  confirmed: "Booking confirmation",
  payment: "Payment",
  declaration: "Declaration / consent",
  "time-slot": "Appointment date picker",
  waiting: "Waiting room",
  mission: "Mission & IVAC Center selection",
  webfile: "Webfile upload",
  "booking-guide": "Appointment booking guide",
  otp: "OTP verification",
  login: "Sign in",
  dashboard: "Dashboard (Take Your Appointment)",
  unknown: "Unrecognized page",
};

// Visible page text without the scrolling notice banner, whose wording
// ("OTP, login credentials", "payment method") would otherwise look like
// other steps.
async function readPageTextWithoutBanner(page) {
  return page.evaluate(() => {
    const clone = document.body ? document.body.cloneNode(true) : null;
    if (!clone) return "";
    clone.querySelectorAll('[class*="marquee"], script, style, template').forEach((node) => node.remove());
    return (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
  }).catch(() => "");
}

// Identifies the portal page that is open right now, using the URL first and
// then visible controls/text.
export async function detectPortalPage(page) {
  const result = (key) => ({ key, label: PORTAL_PAGES[key] });
  if (page.isClosed()) {
    return result("closed");
  }
  let pathname = "";
  try {
    pathname = new URL(page.url()).pathname.toLowerCase();
  } catch {}
  const visible = async (locator) => locator.first().isVisible().catch(() => false);
  const attached = async (locator) => await locator.count().catch(() => 0) > 0;
  const text = await readPageTextWithoutBanner(page);

  if (/(?:appointment|booking) (?:is )?confirmed|successfully booked|download (?:the )?invoice/i.test(text)) {
    return result("confirmed");
  }
  if (/\/(?:continue-payment|confirm-payment|payment)\b/.test(pathname) ||
    await visible(page.getByRole("button", { name: /pay now/i })) ||
    await visible(page.getByRole("heading", { name: /payment details|payment gateway/i }))) {
    return result("payment");
  }
  if (/\/appointment\/declaration\b/.test(pathname)) {
    return result("declaration");
  }
  if (/\/appointment\/time-slot\b/.test(pathname) ||
    await attached(page.locator('button, [role="button"]').filter({ hasText: CONTINUE_BOOKING_PATTERN })) ||
    /select an appointment date|pick up a date/i.test(text)) {
    return result("time-slot");
  }
  if (/\/appointment\/waiting\b/.test(pathname) ||
    /waiting for booking portal|no slots available at the moment/i.test(text)) {
    return result("waiting");
  }
  if (/\/appointment\/mission\b/.test(pathname) ||
    await attached(page.locator('button, [role="button"]').filter({ hasText: MISSION_CONFIRM_PATTERN }))) {
    return result("mission");
  }
  if (await visible(page.locator('input[type="checkbox"]')) && /declaration|i consent|i agree/i.test(text)) {
    return result("declaration");
  }
  if (await attached(page.locator(FILE_INPUT_SELECTOR)) || /upload primary applicant(?:'s|’s)? webfile/i.test(text)) {
    return result("webfile");
  }
  if (/\/to-book-visa-appointment\b/.test(pathname) || /to book your visa appointment/i.test(text) ||
    await visible(page.locator('a, button, [role="button"]').filter({ hasText: /^\s*next step\s*$/i }))) {
    return result("booking-guide");
  }
  if (await isOtpPageVisible(page, text)) {
    return result("otp");
  }
  for (const frame of page.frames()) {
    if (await visible(frame.locator('input[type="password"]'))) {
      return result("login");
    }
  }
  if (await findTakeAppointmentControl(page)) {
    return result("dashboard");
  }
  return result("unknown");
}

export async function runGuidedBookingFlow(page, prompts, credentials = null, flowOptions = {}) {
  await unblockInspectAndPaste(page);
  await dismissPortalNotices(page);

  const startPage = await detectPortalPage(page);
  log.step("Current Page", startPage.label);
  if (RESUMABLE_PAGES.has(startPage.key)) {
    log.info("The portal is already past the Webfile step; continuing the booking from this page.");
    return continueBookingFrom(page, prompts, startPage.key);
  }

  let current = await reportVisibleIssues(page);
  const alreadyAuthed = await isAlreadyLoggedIn(page);
  if (alreadyAuthed) {
    log.success("Active session detected (Already logged in).");
  }

  if (!await isActiveBookingStepReady(page) && !await isWebfileStepReady(page)) {
    if (!alreadyAuthed && !await isAuthenticationPageVisible(page, current.pageText)) {
      const startReady = await waitForPortalStep(page, "appointment entry or sign-in page", [
        { locator: page.getByRole("button", { name: /take your appointment/i }) },
        { locator: page.getByRole("link", { name: /take your appointment/i }) },
        { locator: page.locator('a, button, [role="button"]').filter({ hasText: /take your appointment/i }) },
        { locator: page.getByText(/take your appointment/i) },
        { locator: page.locator('input[type="password"]'), state: "visible" },
        { locator: page.getByRole("button", { name: /book your appointment|book appointment/i }) },
        { locator: page.getByRole("link", { name: /book your appointment|book appointment/i }) },
        { locator: page.locator(FILE_INPUT_SELECTOR).first(), state: "attached" },
      ]);
      if (!startReady) {
        return;
      }
    }

    current = await reportVisibleIssues(page);
    if (!await isAuthenticationPageVisible(page, current.pageText) && !await isActiveBookingStepReady(page) && !await isWebfileStepReady(page)) {
      const takeAppointment = await findTakeAppointmentControl(page);
      if (takeAppointment) {
        log.step("Appointment Entry", "Clicking Take Your Appointment");
        if (!await clickPortalControl(page, takeAppointment, { timeout: 5_000 })) return;
        if (!await waitForBookingStart(page)) {
          log.warn("The browser closed before the sign-in or booking page appeared.");
          return;
        }
        if (await continueIfLaterStep(page, prompts)) {
          return;
        }
      }
    }
  }

  current = await reportVisibleIssues(page);
  if (await isAuthenticationPageVisible(page, current.pageText)) {
    let authOutcome;
    if (await isOtpPageVisible(page, current.pageText)) {
      log.action("Enter the OTP in browser and click Verify OTP; helper will resume automatically.");
      authOutcome = await waitForOtpOrAuth(
        page,
        prompts,
        "Enter the OTP in the browser and click Verify OTP yourself (or press Enter when done): ",
      );
    } else {
      let loginResult = { fieldsFilled: false, submitted: false };
      if (credentials) {
        loginResult = await fillAndSubmitLogin(page, credentials);
      }
      if (!loginResult.fieldsFilled) {
        authOutcome = await waitForOtpOrAuth(
          page,
          prompts,
          "Enter your contact number and password in the browser, complete CAPTCHA, then click Sign In (or press Enter when done): ",
        );
      } else if (!loginResult.submitted) {
        authOutcome = await waitForOtpOrAuth(
          page,
          prompts,
          "Credentials are filled. Complete CAPTCHA and click Sign In in the browser (or press Enter when done): ",
        );
      } else {
        authOutcome = await waitForAuthenticationOutcome(page);
      }

      if (authOutcome === "otp") {
        log.action("The Verify OTP page appeared. Enter the OTP and click Verify OTP in browser.");
        authOutcome = await waitForOtpOrAuth(
          page,
          prompts,
          "Enter the OTP in the browser and click Verify OTP yourself (or press Enter when done): ",
        );
      }
    }
    if (authOutcome !== "authenticated") {
      log.warn("Sign-in was not completed. Guided booking stopped.");
      return;
    }
    log.success("Authentication completed! Booking page is ready.");
  }

  await dismissPortalNotices(page);
  if (!await isActiveBookingStepReady(page) && !await isWebfileStepReady(page)) {
    let takeAfterLogin = await findTakeAppointmentControl(page);
    if (!takeAfterLogin) {
      const bookingStartReady = await waitForPortalStep(page, "booking entry page", [
        { locator: page.getByRole("button", { name: /take your appointment/i }) },
        { locator: page.getByRole("link", { name: /take your appointment/i }) },
        { locator: page.locator('a, button, [role="button"]').filter({ hasText: /take your appointment/i }) },
        { locator: page.getByText(/take your appointment/i) },
        { locator: page.getByRole("button", { name: /next step/i }) },
        { locator: page.getByRole("link", { name: /next step/i }) },
        { locator: page.locator('a, button, [role="button"]').filter({ hasText: /next step/i }) },
        { locator: page.getByRole("button", { name: /book your appointment|book appointment/i }) },
        { locator: page.getByRole("link", { name: /book your appointment|book appointment/i }) },
        { locator: page.locator(FILE_INPUT_SELECTOR).first(), state: "attached" },
      ], 15_000);
      if (!bookingStartReady) {
        return;
      }
      takeAfterLogin = await findTakeAppointmentControl(page);
    }
    if (takeAfterLogin && !await isActiveBookingStepReady(page)) {
      log.step("Appointment Entry", "Clicking Take Your Appointment");
      if (!await clickPortalControl(page, takeAfterLogin, { timeout: 5_000 })) return;
      if (!await waitForBookingStart(page)) {
        log.warn("The browser closed before the booking entry page appeared.");
        return;
      }
    }
  }
  if (await continueIfLaterStep(page, prompts)) {
    return;
  }

  if (!await isWebfileStepReady(page)) {
    let navigation = await waitForBookingNavigation(page, "booking");
    if (navigation.type === "closed") {
      log.warn("The browser closed before the booking page became ready.");
      return;
    }
    if (navigation.type === "next") {
      log.step("Booking Guide", "Advancing through Next Step");
      if (navigation.control.ambiguous || !await clickNextStepIfPresent(page)) {
        log.warn("The Next Step control was ambiguous or the Webfile page did not appear.");
        return;
      }
    } else if (navigation.type === "book") {
      if (navigation.control.ambiguous) {
        log.warn("More than one Book Your Appointment control is visible.");
        return;
      }
      if (!await clickPortalControl(page, navigation.control.locator, { timeout: 5_000 })) return;
      navigation = await waitForNextOrWebfile(page, "the Next Step control or Webfile upload page");
      if (navigation.type === "closed") {
        log.warn("The browser closed before the Webfile upload page appeared.");
        return;
      }
      if (navigation.type === "next") {
        log.step("Booking Guide", "Advancing through Next Step");
        if (navigation.control.ambiguous || !await clickNextStepIfPresent(page)) {
          log.warn("The Next Step control was ambiguous or the Webfile page did not appear.");
          return;
        }
      }
    }
  }

  if (!await isWebfileStepReady(page)) {
    const uploadReady = await waitForPortalStep(page, "Webfile upload", [
      { locator: page.locator(FILE_INPUT_SELECTOR).first(), state: "attached" },
      { locator: page.getByText(/upload primary applicant(?:'s|’s) webfile/i) },
    ]);
    if (!uploadReady) {
      log.warn("The browser closed before the Webfile upload page appeared.");
      return;
    }
  }
  current = await reportVisibleIssues(page);

  const applicants = await getApplicantPdfs(prompts, flowOptions);
  if (!applicants) {
    return;
  }
  // Retry: a failed upload is tried again (the portal's own applicant count
  // tells which files are already in), except when the portal says the
  // Webfile does not match the account; the same file would fail again.
  const MAX_UPLOAD_ATTEMPTS = 3;
  let uploadResult = false;
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
    const pageText = await page.locator("body").innerText({ timeout: 3_000 }).catch(() => "");
    const plan = planApplicantUploads(applicants, pageText);
    if (plan.primaryOnPortal) {
      log.info(`The portal already has Primary Applicant ${plan.primaryOnPortal}; ${path.basename(applicants[0].path)} is a different person, so all ${applicants.length} PDF(s) will be uploaded as other applicants.`);
      if (plan.applicants.length > 4) {
        log.warn(`That would make ${plan.applicants.length} applicants; the portal allows at most 4. Keep only this booking's PDFs in doc_file.`);
        return;
      }
    }
    uploadResult = await uploadApplicantPdfs(page, prompts, plan.applicants, flowOptions);
    if (uploadResult === FILE_ALREADY_UPLOADED || uploadResult) {
      break;
    }
    if (lastUploadIssueKeys.includes("details-mismatch")) {
      log.warn("The portal says this Webfile does not match the account's details. Upload the account holder's Webfile as Primary (or fix doc_file), then press b.");
      break;
    }
    if (attempt < MAX_UPLOAD_ATTEMPTS && (await detectPortalPage(page)).key === "webfile") {
      log.warn(`Upload attempt ${attempt} did not finish; trying again (${attempt + 1} of ${MAX_UPLOAD_ATTEMPTS}).`);
      await dismissPortalNotices(page).catch(() => {});
      await page.waitForTimeout(3_000).catch(() => {});
    } else {
      break;
    }
  }
  if (uploadResult === FILE_ALREADY_UPLOADED) {
    return resumeSavedBooking(page, prompts);
  }
  if (!uploadResult) {
    log.warn("Applicant Webfile upload/confirmation did not complete. Guided booking stopped.");
    return;
  }

  return continueBookingFrom(page, prompts, "mission");
}

// Pages after the Webfile step. When the portal opens on one of these directly
// (for example a resumed session that lands on the date picker), the flow skips
// sign-in and uploads and continues from that page.
const RESUMABLE_PAGES = new Set(["mission", "waiting", "time-slot", "declaration", "payment", "confirmed"]);
// Pages where the helper still has work to do (payment and confirmation are the user's).
const AUTO_RESUME_PAGES = new Set(["mission", "waiting", "time-slot", "declaration"]);

export function isAutoResumePage(key) {
  return AUTO_RESUME_PAGES.has(key);
}

// The portal already holds this booking's Webfiles (it refused a re-upload).
// Open the later booking pages directly and continue from whichever one the
// portal lets us stay on.
const SAVED_BOOKING_PATHS = ["/appointment/time-slot", "/appointment/mission"];

export async function resumeSavedBooking(page, prompts) {
  log.warn("The portal already has these Webfiles from an earlier attempt, so they cannot be uploaded again.");
  let origin = "https://appointment.ivacbd.com";
  try {
    origin = new URL(page.url()).origin;
  } catch {}
  for (const savedPath of SAVED_BOOKING_PATHS) {
    log.step("Resume Booking", `Opening ${savedPath} where the earlier booking was left`);
    await page.goto(`${origin}${savedPath}`, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(2_500).catch(() => {});
    await dismissPortalNotices(page).catch(() => {});
    const current = await detectPortalPage(page);
    log.step("Current Page", current.label);
    if (RESUMABLE_PAGES.has(current.key)) {
      return continueBookingFrom(page, prompts, current.key);
    }
  }
  log.warn("The portal did not open a later booking step. Its saved Webfiles may need the portal's own reset (for example after a session expiry); check the browser.");
  return undefined;
}

async function continueBookingFrom(page, prompts, stage) {
  if (stage === "confirmed") {
    log.success("The booking confirmation page is shown. Check the details and download the invoice in the browser.");
    return;
  }
  if (stage === "payment") {
    log.paymentStop();
    return;
  }

  let centre = "the centre selected earlier";
  let date = "the date selected earlier";
  if (stage === "mission") {
    centre = await chooseCentre(page, prompts);
    if (!centre) {
      return;
    }
  }
  if (stage === "mission" || stage === "waiting" || stage === "time-slot") {
    date = await chooseDate(page, prompts);
    if (!date) {
      return;
    }
    const after = await detectPortalPage(page);
    log.step("Current Page", after.label);
    if (after.key === "payment") {
      log.paymentStop();
      return;
    }
  }

  if (!await completeConsentIfNeeded(page, prompts)) {
    return;
  }
  if (!await waitForCaptchaIfNeeded(page)) {
    return;
  }

  const beforeSubmit = await reportVisibleIssues(page);
  if (beforeSubmit.issues.length > 0) {
    log.warn("Resolve the portal message before submitting the date. Guided booking stopped.");
    return;
  }
  if (await isPaymentStepReady(page)) {
    log.paymentStop();
    return;
  }

  const proceed = await waitForUniqueControlUntilReady(
    page,
    ["button", "link"],
    ["Submit", "Confirm Appointment", "Proceed to Payment", "Continue"],
    "appointment-submit",
  );
  if (!proceed.found) {
    const reason = proceed.ambiguous ? "More than one submit/proceed control was found." : "No unique submit/proceed control was found.";
    log.warn(`${reason} The selected date has not been submitted by the helper. Review the portal and complete that step yourself.`);
    return;
  }

  const approved = await askYesNo(
    prompts,
    `Submit the appointment selection for ${centre} on ${date} and continue to payment? The portal says confirmed bookings cannot be cancelled or rescheduled.`,
  );
  if (!approved) {
    log.info("Appointment submission cancelled. No payment was made.");
    return;
  }

  if (!await clickPortalControl(page, proceed.locator, { timeout: 5_000 })) return;
  const paymentStepReady = await waitForPortalStep(page, "payment or appointment confirmation", [
    { locator: page.getByRole("button", { name: /pay now/i }) },
    { locator: page.getByText(/payment details|payment gateway/i) },
    { locator: page.getByText(/appointment (?:is )?confirmed|booking (?:is )?confirmed/i) },
  ]);
  if (!paymentStepReady) {
    log.warn("The date submission was clicked, but payment or confirmation did not appear. Guided booking stopped; inspect the portal.");
    return;
  }
  const result = await reportVisibleIssues(page);
  if (result.step.key === "payment" || await isPaymentStepReady(page)) {
    log.paymentStop();
  } else {
    log.success(`Date submission action completed for ${date}. Complete final review in browser.`);
  }
}
