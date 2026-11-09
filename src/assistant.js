const BLOCKED_LABEL = /\b(password|passcode|otp|one[- ]time|verification code|captcha|card number|cvv|security code|payment)\b/i;
const POSITIVE_MARKERS = [
  "appointment available",
  "slot available",
  "available appointment",
  "select appointment date",
];
const NEGATIVE_MARKERS = [
  "no appointment available",
  "no slot available",
  "fully booked",
  "no appointments",
];

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
  const text = pageText.toLowerCase().replace(/\s+/g, " ");
  if (NEGATIVE_MARKERS.some((marker) => text.includes(marker))) {
    return "unavailable";
  }
  if (POSITIVE_MARKERS.some((marker) => text.includes(marker))) {
    return "possible";
  }
  return "unknown";
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
