import { open, stat } from "node:fs/promises";
import path from "node:path";
import { getPortalIssues, getPortalStep } from "./assistant.js";

const FILE_INPUT_SELECTOR = 'input[type="file"]';

async function askYesNo(prompts, message) {
  const answer = (await prompts.question(`${message} [y/N]: `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

async function waitForManualStep(prompts, message) {
  await prompts.question(`${message}\nComplete it in the browser, then press Enter here. `);
}

async function findUniqueControl(page, roles, exactNames) {
  for (const role of roles) {
    for (const name of exactNames) {
      const locator = page.getByRole(role, { name, exact: true });
      const count = await locator.count();
      if (count === 1) {
        if (await locator.isVisible() && await locator.isEnabled()) {
          return { found: true, locator, label: name };
        }
        return { found: false, ambiguous: false, label: name };
      }
      if (count > 1) {
        return { found: false, ambiguous: true, label: name };
      }
    }
  }
  return { found: false, ambiguous: false };
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
      if (await notice.locator.count() === 1 && await notice.locator.isVisible().catch(() => false)) {
        activeNotice = notice;
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
    const label = labels.join(" ") || element.getAttribute("aria-label") || "";
    return {
      index: index + 1,
      name,
      id,
      label,
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
    const description = `${item.label} ${item.name} ${item.id}`;
    return isPrimary
      ? /primary.{0,30}web ?file/i.test(description)
      : /secondary|additional|applicant.{0,8}(?:2|3|4)|web ?file/i.test(description) && !/primary/i.test(description);
  };
  const availableInputs = () => details.filter((item) => !item.selected && !usedInputs.has(item.identity));
  let candidates = availableInputs();
  let labelledCandidates = candidates.filter(matchesApplicant);

  if (labelledCandidates.length === 1) {
    return { locator: inputLocator.nth(labelledCandidates[0].index - 1), identity: labelledCandidates[0].identity };
  }
  if (isPrimary && candidates.length === 1) {
    return { locator: inputLocator.nth(candidates[0].index - 1), identity: candidates[0].identity };
  }

  if (!isPrimary && candidates.length === 0) {
    const addApplicant = await findUniqueControl(page, ["button", "link"], [
      "Add Applicant", "Add Another Applicant", "Add Secondary Applicant", "Add Webfile", "Add Another Webfile", "Add Additional Webfile",
    ]);
    if (addApplicant.found) {
      await addApplicant.locator.click({ timeout: 5_000 });
      await page.waitForTimeout(400);
      details = await getFileInputDetails(page);
      candidates = availableInputs();
      labelledCandidates = candidates.filter(matchesApplicant);
      if (labelledCandidates.length === 1) {
        return { locator: inputLocator.nth(labelledCandidates[0].index - 1), identity: labelledCandidates[0].identity };
      }
    }
  }

  if (candidates.length === 0) {
    const label = isPrimary ? "Primary Applicant's Webfile" : `Secondary Applicant ${applicantNumber}'s Webfile`;
    console.log(`No separate empty file input was found for ${label}. The helper will not replace a previously selected applicant file.`);
    await waitForManualStep(prompts, `Open a separate ${label} input in the browser.`);
    details = await getFileInputDetails(page);
    candidates = availableInputs();
    labelledCandidates = candidates.filter(matchesApplicant);
    if (labelledCandidates.length === 1) {
      return { locator: inputLocator.nth(labelledCandidates[0].index - 1), identity: labelledCandidates[0].identity };
    }
  }

  if (candidates.length === 1) {
    return { locator: inputLocator.nth(candidates[0].index - 1), identity: candidates[0].identity };
  }

  if (candidates.length > 1) {
    console.log(`Choose the file input for applicant ${applicantNumber}:`);
    candidates.forEach((item, index) => console.log(`  ${index + 1}. ${item.label || item.name || item.id || `File input ${item.index}`}`));
    const answer = Number((await prompts.question("File input number: ")).trim());
    if (Number.isInteger(answer) && answer >= 1 && answer <= candidates.length) {
      const selected = candidates[answer - 1];
      return { locator: inputLocator.nth(selected.index - 1), identity: selected.identity };
    }
  }
  console.log(`No safe file input was identified for applicant ${applicantNumber}.`);
  return null;
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
  const centreMatches = details.filter((item) => /ivac.{0,20}cent(?:re|er)|cent(?:re|er).{0,20}ivac/i.test(`${item.label} ${item.name} ${item.id}`));

  if (centreMatches.length === 1) {
    const select = selects.nth(centreMatches[0].index);
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
      await select.selectOption({ value: selected.value });
      console.log(`IVAC Centre selected: ${selected.label}`);
      return selected.label;
    }
  }

  console.log("Could not safely identify one IVAC Centre selector. Select the centre in the browser yourself.");
  await waitForManualStep(prompts, "Select the preferred eligible IVAC Centre.");
  return (await prompts.question("Enter the selected centre name for the final review: ")).trim() || "Centre selected in browser";
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function chooseDate(page, prompts) {
  let date;
  while (true) {
    date = (await prompts.question("Preferred available date (YYYY-MM-DD): ")).trim();
    const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
    if (parsed && !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date) {
      break;
    }
    console.log("Enter the date in YYYY-MM-DD format.");
  }

  const dateInputs = page.locator('input[type="date"]');
  const dateInputCount = await dateInputs.count();
  if (dateInputCount === 1) {
    await dateInputs.fill(date);
    return date;
  }
  const labeledDateInput = page.getByLabel(/appointment date/i);
  if (await labeledDateInput.count() === 1) {
    await labeledDateInput.fill(date);
    return date;
  }

  const [year, month, day] = date.split("-");
  const isoLocator = page.locator(`[data-date="${date}"], [data-value="${date}"]`);
  const isoCount = await isoLocator.count();
  if (isoCount === 1 && await isoLocator.isVisible() && await isoLocator.isEnabled()) {
    await isoLocator.click();
    return date;
  }

  const monthLong = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  const monthShort = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" }).format(new Date(`${date}T00:00:00Z`));
  const dayNumber = String(Number(day));
  const datePattern = new RegExp(`(?:\\b${dayNumber}\\b.{0,20}\\b(?:${escapeRegex(monthLong)}|${escapeRegex(monthShort)})\\b.{0,10}\\b${year}\\b|\\b(?:${escapeRegex(monthLong)}|${escapeRegex(monthShort)})\\b.{0,10}\\b${dayNumber}\\b,?\\s+${year}\\b)`, "i");
  const dateButtons = page.getByRole("button", { name: datePattern });
  const dateButtonCount = await dateButtons.count();
  if (dateButtonCount === 1 && await dateButtons.isEnabled()) {
    await dateButtons.click();
    return date;
  }

  const pageText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  const monthYear = new RegExp(`\\b(?:${escapeRegex(monthLong)}|${escapeRegex(monthShort)})\\s+${year}\\b`, "i");
  if (monthYear.test(pageText)) {
    const dayButton = page.getByRole("button", { name: dayNumber, exact: true });
    if (await dayButton.count() === 1 && await dayButton.isEnabled()) {
      await dayButton.click();
      return date;
    }
  }

  console.log(`Could not uniquely identify ${date} in the calendar. Select that date in the browser yourself.`);
  await waitForManualStep(prompts, `Select ${date} in the appointment calendar. Ensure the date is available and in the future.`);
  return date;
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
  await checkbox.check();
  return true;
}

async function waitForCaptchaIfNeeded(page, prompts) {
  const captcha = page.locator('iframe[title*="captcha" i], iframe[src*="captcha" i], .g-recaptcha, [data-sitekey]');
  if (await captcha.count() === 0) {
    return true;
  }
  await waitForManualStep(prompts, "Complete the CAPTCHA directly in the browser. The helper will not solve it.");
  return true;
}

async function reportVisibleIssues(page) {
  const pageText = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "");
  const issues = getPortalIssues(pageText);
  for (const issue of issues) {
    console.warn(`Portal issue: ${issue.label}. ${issue.guidance}`);
  }
  return { pageText, issues, step: getPortalStep(pageText) };
}

function getApplicantCount(pageText) {
  const match = pageText.match(/total number of applicants\s*:\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

async function uploadApplicantPdfs(page, prompts, applicants) {
  const usedInputs = new Set();
  for (let index = 0; index < applicants.length; index += 1) {
    const applicant = applicants[index];
    const applicantNumber = index + 1;
    const fileInput = await chooseFileInput(page, prompts, applicantNumber, usedInputs);
    if (!fileInput) {
      console.log(`Could not safely identify a separate file input for ${applicant.label}. No previous Webfile was replaced.`);
      return false;
    }

    await fileInput.locator.setInputFiles(applicant.path);
    usedInputs.add(fileInput.identity);

    const uploadAction = await findUniqueControl(page, ["button"], ["Upload Webfile", "Upload"]);
    if (uploadAction.found) {
      await uploadAction.locator.click({ timeout: 5_000 });
    }

    await page.waitForTimeout(800);
    let report = await reportVisibleIssues(page);
    if (report.issues.length > 0) {
      console.log(`Resolve the portal message for ${applicant.label} before continuing.`);
      return false;
    }

    let acceptedCount = getApplicantCount(report.pageText);
    if (acceptedCount !== null && acceptedCount > applicantNumber) {
      console.log(`The portal shows ${acceptedCount} applicants after selecting applicant ${applicantNumber}. This does not match the prepared upload order, so guided booking stopped.`);
      return false;
    }
    if (acceptedCount !== null && acceptedCount < applicantNumber) {
      await page.waitForFunction((expectedCount) => {
        const text = document.body?.innerText || "";
        const match = text.match(/total number of applicants\s*:\s*(\d+)/i);
        return match && Number(match[1]) >= expectedCount;
      }, applicantNumber, { timeout: 8_000 }).catch(() => {});
      report = await reportVisibleIssues(page);
      if (report.issues.length > 0) {
        console.log(`Resolve the portal message for ${applicant.label} before continuing.`);
        return false;
      }
      acceptedCount = getApplicantCount(report.pageText);
      if (acceptedCount === null || acceptedCount < applicantNumber) {
        const countDescription = acceptedCount === null ? "an unrecognized applicant count" : `${acceptedCount} applicant(s)`;
        const continueAfterReview = await askYesNo(
          prompts,
          `The portal currently shows ${countDescription} after selecting ${applicant.label}. Has the portal visibly accepted this Webfile? If not, stop and resolve the upload message in the browser.`,
        );
        if (!continueAfterReview) {
          console.log(`Stopped before selecting the next applicant's Webfile.`);
          return false;
        }
        report = await reportVisibleIssues(page);
        if (report.issues.length > 0) {
          console.log(`Resolve the portal message for ${applicant.label} before continuing.`);
          return false;
        }
        acceptedCount = getApplicantCount(report.pageText);
        if (acceptedCount !== null && acceptedCount < applicantNumber) {
          console.log(`The portal still shows ${acceptedCount} applicant(s). The ${applicant.label} Webfile was not confirmed, so guided booking stopped.`);
          return false;
        }
      }
      if (acceptedCount !== null && acceptedCount !== applicantNumber) {
        console.log(`The portal now shows ${acceptedCount} applicants, which does not match applicant ${applicantNumber}. Guided booking stopped.`);
        return false;
      }
    }

    if (index + 1 < applicants.length) {
      const addApplicant = await findUniqueControl(page, ["button", "link"], [
        "Add Applicant", "Add Another Applicant", "Add Secondary Applicant", "Add Webfile", "Add Another Webfile", "Add Additional Webfile",
      ]);
      if (addApplicant.found && (await getFileInputDetails(page)).length <= applicantNumber) {
        await addApplicant.locator.click({ timeout: 5_000 });
        await page.waitForTimeout(400);
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

  const confirmButton = await findUniqueControl(page, ["button"], ["Confirm All Information is Correct"]);
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
  await confirmButton.locator.click({ timeout: 5_000 });
  await page.waitForTimeout(800);
  await dismissPortalNotices(page);
  return true;
}

async function clickNextStepIfPresent(page) {
  const nextStep = await findUniqueControl(page, ["button", "link"], ["Next Step"]);
  if (!nextStep.found) {
    return false;
  }
  await nextStep.locator.click({ timeout: 5_000 });
  await page.waitForTimeout(800);
  await dismissPortalNotices(page);
  console.log("Clicked Next Step to open the applicant Webfile upload page.");
  return true;
}

async function findUniqueLoginField(page, candidates) {
  for (const locator of candidates) {
    const count = await locator.count();
    if (count === 0) {
      continue;
    }
    if (count !== 1) {
      return null;
    }
    if (
      !await locator.isVisible().catch(() => false) ||
      !await locator.isEnabled().catch(() => false)
    ) {
      return null;
    }
    return locator;
  }
  return null;
}

async function fillAndSubmitLogin(page, credentials) {
  const contactField = await findUniqueLoginField(page, [
    page.getByLabel(/contact number|mobile number|phone number|login id|user id/i),
    page.getByPlaceholder(/contact number|mobile number|phone number|login id|user id/i),
    page.locator('input[type="tel"]'),
  ]);
  const passwordField = await findUniqueLoginField(page, [
    page.locator('input[type="password"]'),
    page.getByLabel(/password/i),
  ]);
  const signIn = await findUniqueControl(
    page,
    ["button"],
    ["Sign In Now", "Sign In", "Login", "Log In"],
  );

  if (!contactField || !passwordField || !signIn.found) {
    console.warn("Could not safely identify one contact field, password field, and Sign In button. Complete sign-in in the browser.");
    return false;
  }

  const [contactInfo, passwordInfo] = await Promise.all([
    contactField.evaluate((element) => ({
      tag: element.tagName.toLowerCase(),
      type: (element.getAttribute("type") || "text").toLowerCase(),
      disabled: element.disabled,
      readOnly: element.readOnly,
    })),
    passwordField.evaluate((element) => ({
      tag: element.tagName.toLowerCase(),
      type: (element.getAttribute("type") || "text").toLowerCase(),
      disabled: element.disabled,
      readOnly: element.readOnly,
    })),
  ]);
  if (
    contactInfo.tag !== "input" ||
    !["tel", "text"].includes(contactInfo.type) ||
    contactInfo.disabled ||
    contactInfo.readOnly ||
    passwordInfo.tag !== "input" ||
    passwordInfo.type !== "password" ||
    passwordInfo.disabled ||
    passwordInfo.readOnly
  ) {
    console.warn("The sign-in fields did not match the expected contact-number and password inputs. Complete sign-in in the browser.");
    return false;
  }

  try {
    for (const [field, value] of [
      [contactField, credentials.contactNumber],
      [passwordField, credentials.password],
    ]) {
      await field.click({ timeout: 5_000 });
      await field.press("Control+A", { timeout: 5_000 });
      await field.press("Backspace", { timeout: 5_000 });
      await field.pressSequentially(value, { delay: 45, timeout: 10_000 });
      if (await field.inputValue() !== value) {
        console.warn("The browser did not accept typed text in a sign-in field. Sign In was not clicked.");
        return false;
      }
    }

    await signIn.locator.click({ timeout: 5_000 });
    console.log("Typed the sign-in credentials from credentials.json and clicked Sign In. Complete CAPTCHA/OTP in the browser if prompted.");
    await page.waitForTimeout(1_200);
    await dismissPortalNotices(page);
    return true;
  } catch (error) {
    console.warn("Automatic sign-in could not complete: " + error.message);
    return false;
  }
}

function isOtpPage(pageText) {
  return /(?:verify otp|otp verification|enter (?:the )?otp)/i.test(pageText);
}

function isAuthenticationPage(pageText) {
  return isOtpPage(pageText) || /(?:your contact number|enter your password|sign in now|forgot password|one[- ]time password|verification code)/i.test(pageText);
}

function isBookingPage(step) {
  return ["book", "webfile", "centre", "date", "payment", "confirmed"].includes(step.key);
}

export async function runGuidedBookingFlow(page, prompts, credentials = null) {
  await dismissPortalNotices(page);
  console.log("Guided booking started. The helper will open the sign-in page and fill local credentials when configured; CAPTCHA and OTP stay in the browser.");

  let current = await reportVisibleIssues(page);
  if (!isBookingPage(current.step)) {
    const takeAppointment = await findUniqueControl(page, ["button", "link"], ["Take Your Appointment"]);
    if (takeAppointment.found) {
      await takeAppointment.locator.click({ timeout: 5_000 });
      await page.getByText(/your contact number/i).waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
    } else if (!isAuthenticationPage(current.pageText)) {
      console.log("Could not uniquely identify the Take Your Appointment button. Open the sign-in page manually.");
      await waitForManualStep(prompts, "Click Take Your Appointment and open the Sign In page.");
    }
  }

  current = await reportVisibleIssues(page);
  let credentialsAttempted = false;
  let credentialsFilled = false;
  while (isAuthenticationPage(current.pageText)) {
    if (
      !isOtpPage(current.pageText) &&
      credentials &&
      !credentialsAttempted
    ) {
      credentialsAttempted = true;
      credentialsFilled = await fillAndSubmitLogin(page, credentials);
      if (credentialsFilled) {
        current = await reportVisibleIssues(page);
        if (!isAuthenticationPage(current.pageText)) {
          break;
        }
        if (isOtpPage(current.pageText)) {
          continue;
        }
      }
    }

    const instruction = isOtpPage(current.pageText)
      ? "Enter the OTP in the browser and click Verify OTP yourself. The helper will not collect or type the code. Press Enter here after verification completes."
      : credentialsFilled
        ? "The sign-in page is still open. Complete CAPTCHA if shown, verify the prefilled details, and click Sign In if needed; press Enter here after sign-in completes."
        : credentials
          ? "The login form could not be filled safely. Enter your contact number and password in the browser, complete Cloudflare/CAPTCHA there, and press Enter here after sign-in completes."
          : "Enter your contact number and password in the browser. Complete Cloudflare/CAPTCHA there. If the Verify OTP screen appears, enter the OTP and click Verify OTP yourself; press Enter here after sign-in completes.";
    await waitForManualStep(prompts, instruction);
    await dismissPortalNotices(page);
    current = await reportVisibleIssues(page);
    if (isAuthenticationPage(current.pageText) && !await askYesNo(prompts, "The page still appears to be on sign-in/OTP. Wait for you to finish it and check again?")) {
      console.log("Guided booking stopped before uploading any file.");
      return;
    }
  }  await dismissPortalNotices(page);
  current = await reportVisibleIssues(page);
  if (!isBookingPage(current.step)) {
    const takeAfterLogin = await findUniqueControl(page, ["button", "link"], ["Take Your Appointment"]);
    if (takeAfterLogin.found) {
      await takeAfterLogin.locator.click({ timeout: 5_000 });
      await page.waitForTimeout(800);
      await dismissPortalNotices(page);
      current = await reportVisibleIssues(page);
    }
  }

  const guideHasNextStep = await findUniqueControl(page, ["button", "link"], ["Next Step"]);
  if (!isBookingPage(current.step) && !guideHasNextStep.found && !await askYesNo(prompts, "Are you signed in and ready to start Book Your Appointment?")) {
    console.log("Guided booking stopped before uploading any file.");
    return;
  }

  await clickNextStepIfPresent(page);
  current = await reportVisibleIssues(page);

  const bookingEntry = await findUniqueControl(page, ["button", "link"], ["Book Your Appointment", "Book appointment"]);
  if (!bookingEntry.found && current.step.key !== "webfile") {
    const reason = bookingEntry.ambiguous ? "More than one matching booking control was found." : "No unique booking control was found.";
    console.log(`${reason} Open the appointment booking page manually.`);
    await waitForManualStep(prompts, "Open the Book Your Appointment page.");
    await clickNextStepIfPresent(page);
  } else if (bookingEntry.found) {
    await bookingEntry.locator.click({ timeout: 5_000 });
    await page.waitForTimeout(800);
    await dismissPortalNotices(page);
    await clickNextStepIfPresent(page);
  }

  current = await reportVisibleIssues(page);
  if (current.step.key !== "webfile") {
    const primaryUpload = page.getByText(/upload primary applicant(?:'s|’s) webfile/i);
    if (await primaryUpload.count() === 0) {
      console.log("The applicant Webfile upload page was not recognized. Open it in the browser, then continue.");
      await waitForManualStep(prompts, "Open the Webfile upload page. If the guide screen appears, click Next Step.");
      await clickNextStepIfPresent(page);
      current = await reportVisibleIssues(page);
    }
  }

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
  await page.waitForTimeout(500);

  const date = await chooseDate(page, prompts);
  if (!await completeConsentIfNeeded(page, prompts)) {
    return;
  }
  if (!await waitForCaptchaIfNeeded(page, prompts)) {
    return;
  }

  const beforeSubmit = await reportVisibleIssues(page);
  if (beforeSubmit.issues.length > 0) {
    console.log("Resolve the portal message before submitting the date. Guided booking stopped.");
    return;
  }
  if (beforeSubmit.step.key === "payment") {
    console.log("The portal is at payment. No payment action was taken.");
    return;
  }

  const proceed = await findUniqueControl(page, ["button", "link"], ["Submit", "Confirm Appointment", "Proceed to Payment", "Continue"]);
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

  await proceed.locator.click({ timeout: 5_000 });
  await page.waitForTimeout(1_000);
  const result = await reportVisibleIssues(page);
  if (result.step.key === "payment") {
    console.log("Reached the payment step. Payment was not made; complete it yourself if you want to confirm the appointment.");
  } else {
    console.log(`Date submission action completed for ${date}. Review the current portal page before doing anything else.`);
  }
}
