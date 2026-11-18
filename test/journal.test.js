import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "patchright";
import { recordPage } from "../src/journal.js";

test("journal records the date-picker page structure without input values or tokens", async () => {
  const html = await readFile(new URL("./fixtures/time-slot-page.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html.replace('value="test-token"', 'value="SECRET-TOKEN-123"') + '<input name="phone" value="01712345678">');
    const entry = await recordPage(page);
    assert.equal(entry.page.key, "time-slot");
    assert.ok(entry.headings.length >= 0);
    assert.ok(entry.buttons.some((button) => button.text === "Continue Booking" && button.disabled));
    assert.deepEqual(entry.buttons.filter((button) => /^\d+$/.test(button.text) && !button.disabled).map((button) => button.text), ["18", "19"]);
    assert.equal(entry.turnstile.present, true);
    assert.equal(entry.turnstile.solved, true);
    assert.equal(entry.html.includes("SECRET-TOKEN-123"), false, "token removed");
    assert.equal(entry.html.includes("01712345678"), false, "phone-like digits removed");
    assert.equal(JSON.stringify(entry).includes("Do not share OTP"), false, "notice banner excluded");
  } finally {
    await browser.close();
  }
});
