const BLOCKED_LABEL = /\b(password|passcode|otp|one[- ]time|verification code|captcha|card|cvv|security code|payment)\b/i;
const POSITIVE_MARKERS = [
  "appointment available",
  "appointments available",
  "slot available",
  "slots available",
  "available dates",
  "available appointment",
  "select appointment date",
];
const NEGATIVE_MARKERS = [
  "no appointment available",
  "no appointments available",
  "no appointments are available",
  "no slot available",
  "no slots available",
  "no slots are available",
  "no appointment slots available",
  "no appointment slots are available",
  "appointment slots are not available",
  "fully booked",
  "no appointments",
];

const PORTAL_STEPS = [
  {
    key: "confirmed",
    label: "Booking confirmation",
    guidance: "Check the applicant list and appointment details, then download the invoice.",
    patterns: [/appointment (?:is )?confirmed/i, /booking (?:is )?confirmed/i, /successfully booked/i, /invoice generated/i, /download (?:the )?invoice/i],
  },
  {
    key: "appointment-entry",
    label: "Appointment entry",
    guidance: "Select Take Your Appointment to enter the signed-in booking flow.",
    patterns: [/take your appointment/i],
  },
  {
    key: "booking-guide",
    label: "Appointment booking guide",
    guidance: "Review the Webfile instructions, then select Next Step to open applicant uploads.",
    patterns: [/to book your visa appointment/i],
  },
  {
    key: "payment",
    label: "Payment",
    guidance: "The appointment is confirmed only after successful payment. Complete payment yourself and verify the invoice or payment status.",
    patterns: [/payment gateway/i, /pay now/i, /payment (?:details|options?|method|page)/i],
  },
  {
    key: "date",
    label: "Appointment date selection",
    guidance: "Choose an available future date. The portal does not allow same-day appointments.",
    patterns: [/select appointment date/i, /appointment calendar/i, /available appointment dates/i, /appointment date/i],
  },
  {
    key: "centre",
    label: "IVAC Centre selection",
    guidance: "Choose an eligible centre shown for the Mission in the Primary Webfile.",
    patterns: [/select ivac cent(?:re|er)/i, /ivac cent(?:re|er) selection/i],
  },
  {
    key: "webfile",
    label: "Webfile upload",
    guidance: "Upload the original, unaltered Primary Webfile first, then any applicable Secondary Webfiles. Webfiles must be no more than 30 days old.",
    patterns: [/primary webfile/i, /secondary webfile/i, /upload webfiles?/i, /upload.*webfile/i],
  },
  {
    key: "login",
    label: "Sign in",
    guidance: "Sign in yourself. Complete any OTP or CAPTCHA directly on the portal.",
    patterns: [/sign in to your account/i, /login to your account/i, /forgot password/i, /verify otp|otp verification|enter (?:the )?otp/i, /\b(?:sign[ -]?in|log[ -]?in|login)\b/i],
  },
  {
    key: "book",
    label: "Start appointment booking",
    guidance: "Select \"Book Your Appointment\" to begin. The full booking session is limited to 15 minutes.",
    patterns: [/book your appointment/i, /book appointment/i],
  },
];

const PORTAL_ISSUES = [
  {
    key: "details-mismatch",
    label: "Account and Primary Webfile details may not match",
    guidance: "Compare the sign-up details with the Primary Webfile. The portal restricts profile edits after upload; if the application itself is wrong, create a fresh application and Webfile.",
    pattern: /(?:mismatch|do not match|does not match|not matching)/i,
  },
  {
    key: "webfile-expired",
    label: "Webfile may be older than 30 days",
    guidance: "The FAQ says uploaded Webfiles must be no more than 30 days old. Generate a fresh Webfile if needed.",
    pattern: /(?:web ?files?.{0,80}(?:older than|over|more than)\s*30 days|older than 30 days|expired web ?files?)/i,
  },
  {
    key: "consent-incomplete",
    label: "Consent may be incomplete",
    guidance: "Review the consent section and complete the required consent step yourself.",
    pattern: /(?:incomplete consent|consent.{0,50}(?:required|incomplete|missing)|please.{0,30}consent)/i,
  },
  {
    key: "captcha-failed",
    label: "CAPTCHA or verification may have failed",
    guidance: "Complete the CAPTCHA or verification directly on the portal, then follow its retry instructions.",
    pattern: /(?:captcha|recaptcha).{0,60}(?:fail|invalid|incorrect|expired|try again)|(?:fail|invalid|incorrect).{0,60}(?:captcha|recaptcha)/i,
  },
  {
    key: "slot-unavailable",
    label: "Appointment slot may be unavailable",
    guidance: "Check the live calendar and choose another available future date if one is offered. If no slot is secured, the FAQ says uploaded Webfiles are deleted and must be uploaded again for a new attempt.",
    pattern: /(?:no appointments?(?: are)? available|no appointment slots?(?: are)? available|no slots?(?: are)? available|fully booked|slot.{0,40}(?:unavailable|not available|taken)|appointment.{0,40}(?:unavailable|not available))/i,
  },
  {
    key: "payment-failed",
    label: "Payment may have failed",
    guidance: "A failed payment does not confirm the appointment. Check the portal's payment status before retrying.",
    pattern: /(?:payment.{0,50}(?:fail|declin|unsuccessful|error)|(?:fail|declin|unsuccessful).{0,50}payment)/i,
  },
  {
    key: "session-timeout",
    label: "Booking session may have expired",
    guidance: "The FAQ sets a 15-minute limit for the full booking process. Restart the booking flow if the portal released the slot.",
    pattern: /(?:session.{0,40}(?:expired|timeout|timed out)|booking.{0,40}(?:expired|timed out)|15 minutes.{0,40}(?:exceed|expired|restart))/i,
  },
  {
    key: "generic-validation",
    label: "The portal may be showing a form or upload validation error",
    guidance: "Review the highlighted field and the exact message shown in the browser. This helper does not change or submit the field.",
    pattern: /(?:please correct (?:the )?(?:following|highlighted)|required field|invalid file|file type.{0,40}(?:invalid|not supported)|upload.{0,40}(?:failed|error)|try again later)/i,
  },
];

const GENERIC_PORTAL_ERROR = /(?:something went wrong|unexpected error|error occurred|request failed|unable to .{1,60}|please try again|\b(?:invalid|incorrect)\b)/i;

function normalizePageText(pageText) {
  return String(pageText || "").toLowerCase().replace(/\s+/g, " ").trim();
}

export function isSafeField(label, field) {
  if (!label || BLOCKED_LABEL.test(label) || field.disabled || field.readOnly) {
    return false;
  }

  if (field.tag === "textarea" || field.tag === "select") {
    return true;
  }

  return field.tag === "input" &&
    ["text", "email", "tel", "date", "number", "search", "url"].includes(field.type);
}

export function getAvailabilityState(pageText) {
  const text = normalizePageText(pageText);
  if (NEGATIVE_MARKERS.some((marker) => text.includes(marker))) {
    return "unavailable";
  }
  if (POSITIVE_MARKERS.some((marker) => text.includes(marker))) {
    return "possible";
  }
  return "unknown";
}

export function getPortalStep(pageText) {
  const text = normalizePageText(pageText);
  const step = PORTAL_STEPS.find(({ patterns }) => patterns.some((pattern) => pattern.test(text)));
  return step || {
    key: "unknown",
    label: "Step not recognized",
    guidance: "Continue using the portal manually. Page wording can change, so verify each step on the site.",
  };
}

export function getPortalIssues(pageText) {
  const text = normalizePageText(pageText);
  const issues = PORTAL_ISSUES.filter(({ pattern }) => pattern.test(text)).map(({ key, label, guidance }) => ({
    key,
    label,
    guidance,
  }));
  if (issues.length === 0 && GENERIC_PORTAL_ERROR.test(text)) {
    issues.push({
      key: "unclassified-error",
      label: "The portal may be showing an unrecognized error",
      guidance: "Read the exact message in the browser and follow the portal's instructions. This helper cannot diagnose every changed or applicant-specific message.",
    });
  }
  return issues;
}

export async function fillLabeledFields(page, profile) {
  let filled = 0;
  for (const [label, value] of Object.entries(profile)) {
    if (typeof value !== "string" || !value.trim()) {
      console.warn(`Skipped "${label}": profile values must be non-empty strings.`);
      continue;
    }

    if (BLOCKED_LABEL.test(label)) {
      console.warn(`Skipped "${label}": sensitive fields are never autofilled.`);
      continue;
    }

    const locator = page.getByLabel(label, { exact: true });
    const count = await locator.count();
    if (count !== 1) {
      console.warn(`Skipped "${label}": expected one labeled field, found ${count}.`);
      continue;
    }

    const field = await locator.evaluate((element) => ({
      tag: element.tagName.toLowerCase(),
      type: (element.getAttribute("type") || "text").toLowerCase(),
      disabled: element.disabled,
      readOnly: element.readOnly,
    }));

    if (!isSafeField(label, field)) {
      console.warn(`Skipped "${label}": this field is not eligible for autofill.`);
      continue;
    }

    try {
      if (field.tag === "select") {
        await locator.selectOption({ label: value });
      } else {
        await locator.fill(value);
      }
      filled += 1;
    } catch (error) {
      console.error(`Could not fill "${label}": ${error.message}`);
    }
  }

  return filled;
}
