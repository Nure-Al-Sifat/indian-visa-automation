import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "patchright";
import { fillLabeledFields, getAvailabilityState, getPortalStep, isSafeField } from "../src/assistant.js";

test("only eligible labeled form controls are autofill candidates", () => {
  assert.equal(isSafeField("Applicant name", {
    tag: "input",
    type: "text",
    disabled: false,
    readOnly: false,
  }), true);
  assert.equal(isSafeField("Password", {
    tag: "input",
    type: "password",
    disabled: false,
    readOnly: false,
  }), false);
  assert.equal(isSafeField("OTP", {
    tag: "input",
    type: "text",
    disabled: false,
    readOnly: false,
  }), false);
  assert.equal(isSafeField("Applicant name", {
    tag: "input",
    type: "text",
    disabled: true,
    readOnly: false,
  }), false);
});

test("availability text check distinguishes possible, unavailable, and unknown", () => {
  assert.equal(getAvailabilityState("An appointment available message"), "possible");
  assert.equal(getAvailabilityState("No appointment available"), "unavailable");
  assert.equal(getAvailabilityState("Please try again later"), "unknown");
});

test("recognizes Take Your Appointment, the Next Step guide, and OTP screens", () => {
  assert.equal(getPortalStep("Take Your Appointment").key, "appointment-entry");
  assert.equal(getPortalStep("To book your visa appointment. Select Next Step.").key, "booking-guide");
  assert.equal(getPortalStep("Verify OTP").key, "login");
});

test("autofill changes only exact, eligible label matches", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <label for="name">Applicant full name</label>
      <input id="name" type="text">
      <label for="password">Password</label>
      <input id="password" type="password">
      <label for="date">Appointment date</label>
      <input id="date" type="date">
    `);

    const filled = await fillLabeledFields(page, {
      "Applicant full name": "Example Applicant",
      Password: "must-not-be-filled",
      "Appointment date": "2026-11-10",
      "Unmatched label": "must-not-be-filled",
    });

    assert.equal(filled, 2);
    assert.equal(await page.locator("#name").inputValue(), "Example Applicant");
    assert.equal(await page.locator("#password").inputValue(), "");
    assert.equal(await page.locator("#date").inputValue(), "2026-11-10");
  } finally {
    await browser.close();
  }
});
