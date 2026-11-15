import { open, stat } from "node:fs/promises";
import path from "node:path";
import { getPortalIssues, getPortalStep } from "./assistant.js";

const FILE_INPUT_SELECTOR = 'input[type="file"]';
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
    locator.waitFor({ state, timeout }).then(() => true),
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
  const deadline = Date.now() + timeout;
  while (!page.isClosed() && Date.now() < deadline) {
    if (!await waitForPortalNoticesClosed(page, 2_000)) {
      return false;
    }
    if (await waitForAnyState(candidates, 150)) {
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
  ]);
}

async function isWebfileStepReady(page) {
  if (!await waitForPortalNoticesClosed(page, 2_000)) {
    return false;
  }
  return waitForAnyState([
    { locator: page.locator(FILE_INPUT_SELECTOR).first(), state: "attached" },
    { locator: page.getByText(/upload primary applicant(?:'s|’s) webfile/i) },
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
    { locator: page.getByLabel(/select ivac cent(?:re|er)/i) },
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

async function getApplicantPdfs(prompts) {
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
        if (/upload\s+(?:primary|secondary|additional|applicant).*web\s*file/i.test(prevText)) {
          label = prevText.trim();
        }
      }
    }
    if (!label && element.parentElement) {
      const parent = element.parentElement;
      if (parent.classList.contains("w-full") && !parent.classList.contains("space-y-4")) {
        const parentLabel = parent.querySelector("label");
        if (parentLabel) {
          label = parentLabel.innerText.trim();
        }
      }
    }

    // Identify dangling/auxiliary hidden file inputs (e.g. inputs after action buttons without upload labels)
    const isDangling = Boolean(
      element.previousElementSibling &&
      (element.previousElementSibling.tagName === "BUTTON" ||
       /confirm/i.test(element.previousElementSibling.innerText || ""))
    );

    return {
      index: index + 1,
      name,
      id,
      label,
      isDangling,
      selected: Boolean(element.files && element.files.length),
      identity: id ? `id:${id}` : `input:${name}|index:${index + 1}`,
    };
  }));
}

async function chooseFileInput(page, prompts, applicantNumber, usedInputs) {
  const inputLocator = page.locator(FILE_INPUT_SELECTOR);
  let details = await getFileInputDetails(page);
  const isPrimary = applicantNumber === 1;
  const matchesApplicant = (item) => {
    if (item.isDangling) return false;
    const description = `${item.label} ${item.name} ${item.id}`;
    if (isPrimary) {
      return /primary.{0,30}web ?file/i.test(description) || (!item.label && applicantNumber === 1);
    }
    return new RegExp(`(?:secondary|applicant\\s*${applicantNumber}|additional|web ?file)`, "i").test(description) && !/primary/i.test(description);
  };
  const availableInputs = () => details.filter((item) => !item.selected && !usedInputs.has(item.identity));
  let candidates = availableInputs();
  let labelledCandidates = candidates.filter(matchesApplicant);

  if (labelledCandidates.length === 1) {
    return { locator: inputLocator.nth(labelledCandidates[0].index - 1), identity: labelledCandidates[0].identity };
  }
  const nonDangling = candidates.filter((item) => !item.isDangling);
  if (isPrimary && nonDangling.length === 1) {
    return { locator: inputLocator.nth(nonDangling[0].index - 1), identity: nonDangling[0].identity };
  }
  if (!isPrimary && nonDangling.length >= 1 && labelledCandidates.length === 0) {
    return { locator: inputLocator.nth(nonDangling[0].index - 1), identity: nonDangling[0].identity };
  }

  if (!isPrimary && nonDangling.length === 0) {
    const addApplicant = await findUniqueControl(page, ["button", "link"], [
      "Add Applicant", "Add Another Applicant", "Add Secondary Applicant", "Add Webfile", "Add Another Webfile", "Add Additional Webfile",
    ]);
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
      const freshNonDangling = candidates.filter((item) => !item.isDangling);
      if (freshNonDangling.length >= 1) {
        return { locator: inputLocator.nth(freshNonDangling[0].index - 1), identity: freshNonDangling[0].identity };
      }
    }
  }

  if (candidates.length === 0) {
    const label = isPrimary ? "Primary Applicant's Webfile" : `Secondary Applicant ${applicantNumber}'s Webfile`;
    console.log(`Waiting for an empty ${label} file input. The helper will not replace a previously selected applicant file.`);
    let lastHeartbeat = 0;
    let addAttempted = false;
    while (!page.isClosed()) {
      if (!await waitForPortalNoticesClosed(page)) {
        return null;
      }
      details = await getFileInputDetails(page);
      candidates = availableInputs();
      labelledCandidates = candidates.filter(matchesApplicant);
      if (labelledCandidates.length === 1 || candidates.length > 0) {
        break;
      }
      if (!isPrimary && !addAttempted) {
        const addApplicant = await findUniqueControl(page, ["button", "link"], [
          "Add Applicant", "Add Another Applicant", "Add Secondary Applicant", "Add Webfile", "Add Another Webfile", "Add Additional Webfile",
        ]);
        if (addApplicant.found) {
          addAttempted = true;
          const previousInputCount = await inputLocator.count();
          if (!await clickPortalControl(page, addApplicant.locator, { timeout: 5_000 })) return null;
          if (!await waitForFileInputCount(page, previousInputCount + 1)) {
            return null;
          }
          continue;
        }
      }
      const now = Date.now();
      if (now - lastHeartbeat >= 30_000) {
        console.log(`Still waiting for an empty file input for ${label}.`);
        lastHeartbeat = now;
      }
      await page.waitForTimeout(300).catch(() => {});
    }
    if (page.isClosed()) {
      return null;
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
    if (await waitForAnyEnabled(page, [
      page.locator('input[type="date"]'),
      page.getByLabel(/appointment date/i),
      page.locator('[role="grid"] button'),
      page.locator("select"),
      page.locator('[role="combobox"]'),
      page.locator('button').filter({ hasText: /select appointment date|available dates|\b\d{1,2}:\d{2}\s*(?:am|pm)\b/i }),
    ], 200)) {
      console.log("Portal step ready: appointment-date or time-slot selection.");
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
    console.log("Waiting Room detected: 'Waiting for booking portal to open...'. The portal automatically checks for slot release every 50 seconds.");
    console.log("The helper is actively monitoring; as soon as slots open, it will immediately proceed to date/time selection.");

    let lastHeartbeat = 0;
    while (!page.isClosed()) {
      if (!await waitForPortalNoticesClosed(page, 2_000)) return false;
      url = page.url ? page.url() : "";
      pageText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");

      if (url.includes("/appointment/time-slot") || /(?:select appointment date|available slot|available dates|\b\d{1,2}:\d{2}\s*(?:am|pm)\b)/i.test(pageText)) {
        console.log("Slot window opened! Advanced to appointment time-slot selection.");
        return true;
      }

      const now = Date.now();
      if (now - lastHeartbeat >= 30_000) {
        const timerMatch = pageText.match(/(\d{1,2}\s*[hH]\s*\d{1,2}\s*[mM]\s*\d{1,2}\s*[sS]|\d{1,2}:\d{2}:\d{2})/);
        const timerInfo = timerMatch ? ` Countdown: ${timerMatch[1]}` : "";
        console.log(`Still in waiting room.${timerInfo} Monitoring for slot opening...`);
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
      console.log(`Selecting available slot time: ${(await btn.innerText().catch(() => "")).trim()}`);
      await clickPortalControl(page, btn, { timeout: 3_000 });
      break;
    }
  }
}

async function clickSlotContinueIfPresent(page) {
  const continueButtons = page.locator('button').filter({ hasText: /^(?:continue|proceed|next step|confirm slot|book slot)$/i });
  if (await continueButtons.count() > 0 && await continueButtons.first().isEnabled().catch(() => false)) {
    console.log("Clicking Continue to proceed to next step...");
    await clickPortalControl(page, continueButtons.first(), { timeout: 5_000 });
  }
}

async function chooseCentre(page, prompts) {
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
          console.log("No valid IVAC Centre was selected.");
          return null;
        }
        selected = options[answer - 1];
      }
      if (!await waitForPortalNoticesClosed(page)) {
        return null;
      }
      await select.selectOption({ value: selected.value });
      if (await select.inputValue() !== selected.value) {
        console.log("The IVAC Centre selection did not remain selected. Guided booking stopped before date selection.");
        return null;
      }
      console.log(`IVAC Centre selected: ${selected.label}`);

      // If on /appointment/mission, click submit/continue button
      const nextBtn = page.locator('button').filter({ hasText: /^(?:next step|continue|proceed|submit)$/i });
      if (await nextBtn.count() > 0 && await nextBtn.first().isEnabled().catch(() => false)) {
        await clickPortalControl(page, nextBtn.first(), { timeout: 5_000 });
      }

      if (!await waitForDateStep(page)) {
        console.log("The centre was selected, but the appointment-date step did not appear. Guided booking stopped for review.");
        return null;
      }
      return selected.label;
    }
  }

  // Check selectable centre cards / buttons
  const centreCards = page.locator('button, [role="button"], label').filter({
    hasText: /\b(dhaka|chittagong|sylhet|rajshahi|khulna|barisal|mymensingh|rangpur|cumilla|noakhali|brahmanbaria|satkhira|jashore|bogura|thakurgaon)\b/i,
  });
  if (await centreCards.count() > 0) {
    const cardText = (await centreCards.first().innerText()).trim();
    console.log(`Selecting available centre card: ${cardText}`);
    await clickPortalControl(page, centreCards.first(), { timeout: 3_000 });
    const nextBtn = page.locator('button').filter({ hasText: /^(?:next step|continue|proceed|submit)$/i });
    if (await nextBtn.count() > 0 && await nextBtn.first().isEnabled().catch(() => false)) {
      await clickPortalControl(page, nextBtn.first(), { timeout: 5_000 });
    }
    if (await waitForDateStep(page)) return cardText;
  }

  console.log("Could not safely identify one IVAC Centre selector. Select the centre in the browser yourself.");
  console.log("Select the preferred eligible IVAC Centre in the browser; waiting for the date selector to appear.");
  if (!await waitForDateStep(page)) {
    console.log("The appointment-date step did not appear after centre selection. Guided booking stopped for review.");
    return null;
  }
  return (await prompts.question("Enter the selected centre name for the final review: ")).trim() || "Centre selected in browser";
}

async function chooseDate(page, prompts) {
  // Check if portal is in the waiting room
  if (!await handleWaitingRoomIfNeeded(page)) return null;

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
      console.log(`Selected appointment date: ${chosen.label}`);
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
    console.log("Selecting available time slot...");
    await clickPortalControl(page, availableSlotButtons.first());
    await waitForCaptchaIfNeeded(page);
    await clickSlotContinueIfPresent(page);
    if (await waitForSubmitStep()) return date || "First available slot";
  }

  // Fallback: let user select in browser if custom calendar
  console.log("Select the preferred date and slot in the browser; waiting for next step...");
  if (!await waitForSubmitStep()) {
    console.log("The consent/submit step did not appear after date selection. Guided booking stopped for review.");
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
  console.log(`Portal consent text: ${consent[0].label}`);
  if (!await askYesNo(prompts, "Do you agree to this consent and want the helper to select it?")) {
    console.log("Consent was not selected. Guided booking stopped.");
    return false;
  }
  if (!await waitForPortalNoticesClosed(page)) return false;
  await checkbox.check();
  if (!await checkbox.isChecked()) {
    console.log("The consent checkbox did not remain selected. Guided booking stopped before submission.");
    return false;
  }
  return true;
}

async function waitForCaptchaIfNeeded(page) {
  const captcha = page.locator('iframe[title*="captcha" i], iframe[src*="captcha" i], .g-recaptcha, [data-sitekey]');
  if (await captcha.count() === 0) {
    return true;
  }
  console.log("Complete the CAPTCHA directly in the browser. Waiting for the portal to register it; the helper will not solve it.");
  let lastHeartbeat = 0;
  while (!page.isClosed()) {
    if (!await waitForPortalNoticesClosed(page)) {
      return false;
    }
    const solved = await page.locator('textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"], input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]')
      .evaluateAll((elements) => elements.some((element) => Boolean(element.value?.trim())))
      .catch(() => false);
    if (solved) {
      console.log("The portal has registered the CAPTCHA response.");
      return true;
    }
    const now = Date.now();
    if (now - lastHeartbeat >= 30_000) {
      await reportVisibleIssues(page);
      console.log("Still waiting for the CAPTCHA response to be registered by the portal.");
      lastHeartbeat = now;
    }
    await page.waitForTimeout(300).catch(() => {});
  }
  return false;
}

async function reportVisibleIssues(page) {
  const pageText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  const issues = getPortalIssues(pageText);
  const previousIssues = lastVisibleIssuesByPage.get(page) || new Set();
  const currentIssueKeys = new Set(issues.map(({ key }) => key));
  for (const issue of issues) {
    if (!previousIssues.has(issue.key)) {
      console.warn(`Portal issue: ${issue.label}. ${issue.guidance}`);
    }
  }
  lastVisibleIssuesByPage.set(page, currentIssueKeys);
  return { pageText, issues, step: getPortalStep(pageText) };
}

function getApplicantCount(pageText) {
  const match = pageText.match(/total (?:number of )?applicants\s*:\s*(\d+)/i)
    || pageText.match(/applicants\s*:\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

async function waitForApplicantCount(page, expectedCount, timeout = 45_000) {
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
    if (count === null) {
      const pageText = await page.locator("body").innerText({ timeout: 2_000 }).catch(() => "");
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

async function uploadApplicantPdfs(page, prompts, applicants) {
  const usedInputs = new Set();
  for (let index = 0; index < applicants.length; index += 1) {
    const applicant = applicants[index];
    const applicantNumber = index + 1;
    console.log(`Preparing upload for applicant ${applicantNumber} of ${applicants.length} (${applicant.label}): ${path.basename(applicant.path)}...`);

    const fileInput = await chooseFileInput(page, prompts, applicantNumber, usedInputs);
    if (!fileInput) {
      console.log(`Could not safely identify a separate file input for ${applicant.label}. No previous Webfile was replaced.`);
      return false;
    }

    if (!await waitForPortalNoticesClosed(page)) return false;
    await fileInput.locator.setInputFiles(applicant.path);
    usedInputs.add(fileInput.identity);

    const uploadControls = ["Upload Webfile", "Upload"].map((name) => page.getByRole("button", { name, exact: true }));
    let uploadControlExists = false;
    for (const locator of uploadControls) {
      if (await locator.count().catch(() => 0) > 0) {
        uploadControlExists = true;
        break;
      }
    }
    if (uploadControlExists) {
      const uploadAction = await waitForUniqueControlUntilReady(
        page,
        ["button"],
        ["Upload Webfile", "Upload"],
        `Upload Webfile for ${applicant.label}`,
      );
      if (!uploadAction.found) {
        console.log("The upload action is ambiguous. The helper stopped before submitting a Webfile.");
        return false;
      }
      if (!await clickPortalControl(page, uploadAction.locator, { timeout: 5_000 })) return false;
    }

    let report = await reportVisibleIssues(page);
    if (report.issues.length > 0) {
      console.log(`Resolve the portal message for ${applicant.label} before continuing.`);
      return false;
    }

    const acceptedCount = await waitForApplicantCount(page, applicantNumber);
    report = await reportVisibleIssues(page);
    if (report.issues.length > 0) {
      console.log(`Resolve the portal message for ${applicant.label} before continuing.`);
      return false;
    }
    if (acceptedCount === null) {
      console.log(`The browser closed or timed out before the portal confirmed ${applicant.label}. The next applicant was not started.`);
      return false;
    }
    if (acceptedCount < applicantNumber) {
      console.log(`The portal shows ${acceptedCount} applicant(s), which does not match applicant ${applicantNumber}. The next applicant was not started.`);
      return false;
    }
    console.log(`Applicant ${applicantNumber} successfully verified. Portal confirmed applicant count: ${acceptedCount}.`);

    if (index + 1 < applicants.length) {
      const details = await getFileInputDetails(page);
      const nonDangling = details.filter((item) => !item.isDangling);
      if (nonDangling.length <= applicantNumber) {
        const addApplicant = await findUniqueControl(page, ["button", "link"], [
          "Add Applicant", "Add Another Applicant", "Add Secondary Applicant", "Add Webfile", "Add Another Webfile", "Add Additional Webfile",
        ]);
        if (addApplicant.found) {
          console.log(`Clicking ${addApplicant.label} to add next applicant slot...`);
          const previousInputCount = await page.locator(FILE_INPUT_SELECTOR).count();
          if (!await clickPortalControl(page, addApplicant.locator, { timeout: 5_000 })) return false;
          if (!await waitForFileInputCount(page, previousInputCount + 1)) {
            console.log("Add Applicant was clicked, but the next Webfile input did not appear. Guided booking stopped.");
            return false;
          }
        }
      }
    }
  }

  const finalReport = await reportVisibleIssues(page);
  if (finalReport.issues.length > 0) {
    console.log("Resolve the portal message before confirming applicant Webfiles.");
    return false;
  }
  const portalApplicantCount = getApplicantCount(finalReport.pageText);
  if (portalApplicantCount !== null && portalApplicantCount !== applicants.length) {
    console.log(`The portal shows ${portalApplicantCount} applicant(s), but ${applicants.length} Webfile(s) were prepared. Guided booking stopped.`);
    return false;
  }
  if (portalApplicantCount === null && !await askYesNo(prompts, `Does the portal show all ${applicants.length} applicants with their correct Webfiles?`)) {
    return false;
  }

  // Check if Turnstile is running on the Webfile page
  await waitForCaptchaIfNeeded(page);

  const confirmButton = await waitForUniqueControlUntilReady(
    page,
    ["button"],
    ["Confirm All Information is Correct"],
    "applicant confirmation",
  );
  if (!confirmButton.found) {
    console.log("Could not uniquely identify the applicant confirmation button. Review the page and confirm manually.");
    return false;
  }
  if (!await askYesNo(
    prompts,
    `Confirm the ${applicants.length} applicant Webfiles are correct and continue? This saves the Primary Webfile, which the portal says cannot be deleted or reuploaded.`,
  )) {
    console.log("Applicant Webfile confirmation cancelled.");
    return false;
  }
  console.log("Clicking Confirm All Information is Correct...");
  if (!await clickPortalControl(page, confirmButton.locator, { timeout: 5_000 })) return false;

  // Handle any confirmation popup/modal if present
  const dialogConfirm = page.locator('[role="dialog"] button, .modal button').filter({ hasText: /yes|confirm|proceed|ok|continue/i });
  if (await dialogConfirm.count().catch(() => 0) > 0 && await dialogConfirm.first().isVisible().catch(() => false)) {
    console.log("Confirming portal dialog modal...");
    await clickPortalControl(page, dialogConfirm.first(), { timeout: 3_000 });
  }

  const bookingStepReady = await waitForPortalStep(page, "IVAC Centre/date selection", [
    { locator: page.getByText(/select ivac cent(?:re|er)/i) },
    { locator: page.locator("select"), state: "visible" },
    { locator: page.locator('input[type="date"]'), state: "visible" },
    { locator: page.getByText(/appointment calendar|select appointment date/i) },
  ]);
  if (!bookingStepReady) {
    console.log("Applicant confirmation was clicked, but the centre/date step did not appear. Guided booking stopped for review.");
    return false;
  }
  console.log("Applicant confirmation complete. Arrived at IVAC Centre/date selection.");
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
        console.warn("The contact-number field did not retain the typed value. Sign In was not clicked.");
        return { fieldsFilled: false, submitted: false };
      }
      const passwordFilled = await setLoginInputValue(page, passwordField, credentials.password);
      if (!passwordFilled) {
        console.warn("The password field did not retain the typed value. Sign In was not clicked.");
        return { fieldsFilled: false, submitted: false };
      }

      console.log("Set the contact number and password into the visible sign-in fields.");
      let enabled = await submitButton.isEnabled().catch(() => false);
      let lastHeartbeat = 0;
      const enableDeadline = Date.now() + 60_000;
      if (!enabled) {
        console.log("Credentials are filled. Complete Cloudflare/CAPTCHA in the browser; the helper is waiting for Sign In to become available.");
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
            console.log("Still waiting for CAPTCHA or portal validation to enable Sign In.");
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
      console.log("Clicked Sign In after verifying both fields.");
      return { fieldsFilled: true, submitted: true };
    } catch (error) {
      console.warn("Automatic sign-in could not complete: " + error.message);
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
  return isOtpPage(pageText) || await page.locator('input[autocomplete="one-time-code"]').isVisible().catch(() => false);
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

async function waitForOtpOrAuth(page, prompts, promptMessage, timeout = 120_000) {
  let promptDone = false;
  if (prompts && typeof prompts.question === "function") {
    prompts.question(promptMessage).then(() => {
      promptDone = true;
    }).catch(() => {
      promptDone = true;
    });
  }

  const deadline = Date.now() + timeout;
  let lastHeartbeat = 0;
  while (!page.isClosed() && Date.now() < deadline) {
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

    if (promptDone) {
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
      console.log("Waiting for authentication/OTP verification to complete...");
      lastHeartbeat = now;
    }
    await page.waitForTimeout(300).catch(() => {});
  }
  return "closed";
}

async function waitForAuthenticationOutcome(page, afterOtp = false, timeout = 60_000) {
  let lastHeartbeat = 0;
  let sawAlert = false;
  const deadline = Date.now() + timeout;
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
    if (!sawAlert && await page.getByRole("alert").isVisible().catch(() => false)) {
      console.warn("The portal displayed an authentication alert. Resolve it in the browser; the helper is waiting for the next page state.");
      sawAlert = true;
    }
    const now = Date.now();
    if (now - lastHeartbeat >= 30_000) {
      await reportVisibleIssues(page);
      console.log(afterOtp
        ? "Waiting for OTP verification to finish and the authenticated booking page to appear."
        : "Waiting for the sign-in result: OTP verification or the authenticated booking page.");
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

export async function runGuidedBookingFlow(page, prompts, credentials = null) {
  await unblockInspectAndPaste(page);
  await dismissPortalNotices(page);
  console.log("Guided booking started. Each portal action waits for its next page/control state before the helper continues; CAPTCHA and OTP stay in the browser.");

  let current = await reportVisibleIssues(page);
  const alreadyAuthed = await isAlreadyLoggedIn(page);
  if (alreadyAuthed) {
    console.log("Active session detected (already logged in).");
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
        console.log("Clicking Take Your Appointment...");
        if (!await clickPortalControl(page, takeAppointment, { timeout: 5_000 })) return;
        if (!await waitForBookingStart(page)) {
          console.log("The browser closed before the sign-in or booking page appeared.");
          return;
        }
      }
    }
  }

  current = await reportVisibleIssues(page);
  if (await isAuthenticationPageVisible(page, current.pageText)) {
    let authOutcome;
    if (await isOtpPageVisible(page, current.pageText)) {
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
        console.log("The Verify OTP page appeared. Enter the OTP and click Verify OTP in the browser; the helper will continue only after the authenticated booking page appears.");
        authOutcome = await waitForOtpOrAuth(
          page,
          prompts,
          "Enter the OTP in the browser and click Verify OTP yourself (or press Enter when done): ",
        );
      }
    }
    if (authOutcome !== "authenticated") {
      console.log("The browser closed before sign-in completed. No booking action was started.");
      return;
    }
    console.log("Authentication completed; the booking page is ready.");
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
      console.log("Clicking Take Your Appointment...");
      if (!await clickPortalControl(page, takeAfterLogin, { timeout: 5_000 })) return;
      if (!await waitForBookingStart(page)) {
        console.log("The browser closed before the booking entry page appeared.");
        return;
      }
    }
  }

  if (!await isWebfileStepReady(page)) {
    let navigation = await waitForBookingNavigation(page, "booking");
    if (navigation.type === "closed") {
      console.log("The browser closed before the booking page became ready.");
      return;
    }
    if (navigation.type === "next") {
      if (navigation.control.ambiguous || !await clickNextStepIfPresent(page)) {
        console.log("The Next Step control was ambiguous or the Webfile page did not appear. Guided booking stopped without starting an upload.");
        return;
      }
    } else if (navigation.type === "book") {
      if (navigation.control.ambiguous) {
        console.log("More than one Book Your Appointment control is visible. Guided booking stopped without clicking either one.");
        return;
      }
      if (!await clickPortalControl(page, navigation.control.locator, { timeout: 5_000 })) return;
      navigation = await waitForNextOrWebfile(page, "the Next Step control or Webfile upload page");
      if (navigation.type === "closed") {
        console.log("The browser closed before the Webfile upload page appeared.");
        return;
      }
      if (navigation.type === "next" &&
        (navigation.control.ambiguous || !await clickNextStepIfPresent(page))) {
        console.log("The Next Step control was ambiguous or the Webfile page did not appear. Guided booking stopped without starting an upload.");
        return;
      }
    }
  }

  if (!await isWebfileStepReady(page)) {
    const uploadReady = await waitForPortalStep(page, "Webfile upload", [
      { locator: page.locator(FILE_INPUT_SELECTOR).first(), state: "attached" },
      { locator: page.getByText(/upload primary applicant(?:'s|’s) webfile/i) },
    ]);
    if (!uploadReady) {
      console.log("The browser closed before the Webfile upload page appeared.");
      return;
    }
  }
  current = await reportVisibleIssues(page);

  const applicants = await getApplicantPdfs(prompts);
  if (!applicants) {
    return;
  }
  if (!await uploadApplicantPdfs(page, prompts, applicants)) {
    console.log("Applicant Webfile upload/confirmation did not complete. Guided booking stopped.");
    return;
  }

  const centre = await chooseCentre(page, prompts);
  if (!centre) {
    return;
  }

  const date = await chooseDate(page, prompts);
  if (!date) {
    return;
  }
  if (!await completeConsentIfNeeded(page, prompts)) {
    return;
  }
  if (!await waitForCaptchaIfNeeded(page)) {
    return;
  }

  const beforeSubmit = await reportVisibleIssues(page);
  if (beforeSubmit.issues.length > 0) {
    console.log("Resolve the portal message before submitting the date. Guided booking stopped.");
    return;
  }
  if (await isPaymentStepReady(page)) {
    console.log("The portal is at payment. No payment action was taken.");
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
    console.log(`${reason} The selected date has not been submitted by the helper. Review the portal and complete that step yourself if appropriate.`);
    return;
  }

  const approved = await askYesNo(
    prompts,
    `Submit the appointment selection for ${centre} on ${date} and continue to payment? The portal says confirmed bookings cannot be cancelled or rescheduled.`,
  );
  if (!approved) {
    console.log("Appointment submission cancelled. No payment was made.");
    return;
  }

  if (!await clickPortalControl(page, proceed.locator, { timeout: 5_000 })) return;
  const paymentStepReady = await waitForPortalStep(page, "payment or appointment confirmation", [
    { locator: page.getByRole("button", { name: /pay now/i }) },
    { locator: page.getByText(/payment details|payment gateway/i) },
    { locator: page.getByText(/appointment (?:is )?confirmed|booking (?:is )?confirmed/i) },
  ]);
  if (!paymentStepReady) {
    console.log("The date submission was clicked, but payment or confirmation did not appear. Guided booking stopped; inspect the portal before retrying.");
    return;
  }
  const result = await reportVisibleIssues(page);
  if (result.step.key === "payment") {
    console.log("Reached the payment step. Payment was not made; complete it yourself if you want to confirm the appointment.");
  } else {
    console.log(`Date submission action completed for ${date}. Review the current portal page before doing anything else.`);
  }
}
