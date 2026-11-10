import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "patchright";
import { dismissPortalNotices, runGuidedBookingFlow } from "../src/booking.js";

test("dismisses repeated IVAC notices using their close controls, never the download button", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <style>
        [role="dialog"] { position: fixed; left: 100px; top: 30px; width: 600px; height: 400px; background: white; }
        .close { position: absolute; top: 10px; right: 10px; width: 36px; height: 36px; }
        .download { position: absolute; left: 20px; bottom: 10px; width: 300px; height: 44px; }
      </style>
      <section role="dialog" id="important">
        <button class="close" aria-label="Close" onclick="window.importantCloseClicked = true; this.closest('[role=dialog]').hidden = true; document.querySelector('#undertaking').hidden = false">×</button>
        <h2>Important Notice</h2>
      </section>
      <section role="dialog" id="undertaking" hidden>
        <button class="close" aria-label="Close" onclick="window.undertakingCloseClicked = true; this.closest('[role=dialog]').hidden = true">×</button>
        <h2>ADVISORY - Mandatory Submission of Visa Undertaking Form</h2>
        <h3>ADVISORY ON FRAUDULENT VISA APPOINTMENT SLOT OFFERS</h3>
        <button class="download" onclick="window.downloadClicked = true">Download Visa Undertaking Form</button>
      </section>
    `);

    const dismissed = await dismissPortalNotices(page);
    assert.equal(dismissed, true, JSON.stringify(await page.evaluate(() => ({
      importantCloseClicked: Boolean(window.importantCloseClicked),
      undertakingCloseClicked: Boolean(window.undertakingCloseClicked),
      importantHidden: document.querySelector("#important").hidden,
      undertakingHidden: document.querySelector("#undertaking").hidden,
    }))));
    assert.equal(await page.locator("#important").isVisible(), false);
    assert.equal(await page.locator("#undertaking").isVisible(), false);
    assert.equal(await page.evaluate(() => Boolean(window.downloadClicked)), false);
  } finally {
    await browser.close();
  }
});

test("closes notices, opens Next Step, uploads each applicant, selects, and submits only to payment", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ivac-booking-test-"));
  const primaryPdf = path.join(tempDir, "primary-webfile.pdf");
  const secondaryPdf = path.join(tempDir, "secondary-webfile.pdf");
  try {
    await writeFile(primaryPdf, "%PDF-1.4\nmock primary Webfile for local UI test\n");
    await writeFile(secondaryPdf, "%PDF-1.4\nmock secondary Webfile for local UI test\n");
    const page = await browser.newPage();
    await page.setContent('<button id="take">Take Your Appointment</button>');
    await page.locator("#take").evaluate((button) => button.addEventListener("click", () => {
      document.body.innerHTML = `
        <h1>Sign In</h1>
        <label for="contact">Your Contact Number</label><input id="contact" type="tel">
        <label for="password">Password</label><input id="password" type="password" placeholder="Enter your password">
        <button>Sign In Now</button>
      `;
    }));

    const questions = [];
    const selectedFiles = [];
    let manuallyVerifiedOtp = false;
    const showDashboard = async () => {
      await page.setContent(`
        <button id="takeAfterLogin">Take Your Appointment</button>
        <button>Check Payment Status</button><button>Profile</button><button>Logout</button>
        <section role="dialog" id="postOtpNotice">
          <button aria-label="Close" onclick="window.postOtpNoticeClosed = true; this.closest('[role=dialog]').hidden = true">×</button>
          <h2>Important Notice</h2>
        </section>
      `);
      await page.locator("#postOtpNotice button").evaluate((button) => button.addEventListener("click", () => {
        window.postOtpNoticeClosed = true;
        button.closest("[role=dialog]").hidden = true;
      }));
      await page.locator("#takeAfterLogin").evaluate((button) => button.addEventListener("click", () => {
        window.postLoginTakeClicked = true;
        document.body.innerHTML = `
          <h1>To book your visa appointment</h1>
          <ul><li>Upload your primary web file first.</li><li>You may upload additional web files if required.</li></ul>
          <button id="next">Next Step</button>
        `;
        document.querySelector("#next").addEventListener("click", () => {
          window.nextStepClicked = true;
          document.body.innerHTML = `
            <section id="upload-page">
              <h2>Total number of applicants: <span id="applicant-count">0</span></h2>
              <label for="primary">Upload Primary Applicant's Webfile</label><input id="primary" type="file">
              <button id="add">Add Applicant</button>
              <button id="confirm">Confirm All Information is Correct</button>
            </section>
          `;
          window.selectedFiles = [];
          document.querySelector("#primary").addEventListener("change", function () {
            window.selectedFiles.push(this.files[0].name);
            document.querySelector("#applicant-count").textContent = "1";
          });
          document.querySelector("#add").addEventListener("click", () => {
            document.querySelector("#add").insertAdjacentHTML("beforebegin", `
              <label for="secondary">Upload Secondary Applicant 2's Webfile</label>
              <input id="secondary" type="file">
            `);
            document.querySelector("#secondary").addEventListener("change", function () {
              window.selectedFiles.push(this.files[0].name);
              document.querySelector("#applicant-count").textContent = "2";
            });
          });
          document.querySelector("#confirm").addEventListener("click", () => {
            window.applicantsConfirmed = true;
            document.body.innerHTML = `
              <label for="centre">Select IVAC Centre</label>
              <select id="centre">
                <option value="" disabled>Select Centre</option>
                <option value="dhaka">Dhaka</option>
                <option value="sylhet">Sylhet</option>
              </select>
              <label for="date">Appointment Date</label><input id="date" type="date">
              <label for="consent">I consent to the appointment terms</label><input id="consent" type="checkbox">
              <button id="submit">Proceed to Payment</button>
            `;
            document.querySelector("#submit").addEventListener("click", () => {
              window.submitted = true;
              document.body.innerHTML = '<h1>Payment Details</h1><button id="pay">Pay Now</button>';
            });
          });
        });
      }));
    };
    const prompts = {
      async question(message) {
        questions.push(message);
        if (message.startsWith("Enter your contact number")) {
          await page.setContent('<h1>Verify OTP</h1><label for="otp">OTP</label><input id="otp" type="text"><button id="verify">Verify OTP</button>');
          return "";
        }
        if (message.startsWith("Enter the OTP in the browser")) {
          await page.locator("#verify").click();
          manuallyVerifiedOtp = true;
          await showDashboard();
          return "";
        }
        if (message.startsWith("The page still appears to be on sign-in/OTP")) return "y";
        if (message.startsWith("How many applicants")) return "2";
        if (message.startsWith("Path to Primary Applicant")) return primaryPdf;
        if (message.startsWith("Path to Secondary Applicant 2")) return secondaryPdf;
        if (message.startsWith("Upload these 2 original PDF")) return "y";
        if (message.startsWith("The portal currently shows")) return "y";
        if (message.startsWith("Confirm the 2 applicant Webfiles")) return "y";
        if (message.startsWith("Choose the preferred centre")) return "2";
        if (message.startsWith("Preferred available date")) return "2026-11-18";
        if (message.startsWith("Do you agree to this consent")) return "y";
        if (message.startsWith("Submit the appointment selection")) return "y";
        return "";
      },
    };

    await runGuidedBookingFlow(page, prompts);

    assert.ok(questions.some((message) => message.startsWith("Enter your contact number")), "waits for the user to complete login/OTP in the browser");
    assert.ok(questions.some((message) => message.startsWith("Enter the OTP in the browser and click Verify OTP yourself")), "recognizes the Verify OTP screen and hands it to the user");
    assert.equal(manuallyVerifiedOtp, true, "continues after the user verifies the OTP");
    assert.equal(await page.evaluate(() => Boolean(window.postOtpNoticeClosed)), true, "closes the Important Notice that appears after OTP verification");
    assert.equal(await page.evaluate(() => Boolean(window.postLoginTakeClicked)), true, "clicks Take Your Appointment again after OTP returns to the signed-in homepage");
    assert.equal(await page.evaluate(() => Boolean(window.nextStepClicked)), true, "clicks Next Step on the booking guide screen");
    assert.ok(questions.some((message) => message.startsWith("How many applicants")), "asks for the number of applicant Webfiles");
    assert.deepEqual(await page.evaluate(() => window.selectedFiles), ["primary-webfile.pdf", "secondary-webfile.pdf"], "uploads each distinct applicant Webfile in order");
    assert.equal(await page.evaluate(() => Boolean(window.applicantsConfirmed)), true, "confirms all uploaded applicant information after the count matches");
    assert.ok(questions.some((message) => message.startsWith("Submit the appointment selection")), "confirms the selected centre/date before submission");
    assert.equal(await page.locator("#pay").isVisible(), true, "stops at payment");
    assert.equal(await page.evaluate(() => Boolean(window.submitted)), true);
    assert.equal(await page.evaluate(() => Boolean(window.paid)), false, "does not make payment");
  } finally {
    await browser.close();
    await unlink(primaryPdf).catch(() => {});
    await unlink(secondaryPdf).catch(() => {});
    await rmdir(tempDir).catch(() => {});
  }
});

test("sets contact number and password despite paste/inspect restrictions and clicks Sign In Now", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <form id="loginForm">
        <h1>Sign In</h1>
        <label>Your Contact Number </label>
        <input name="phone" placeholder="01......" onpaste="return false;" oncontextmenu="return false;">
        <label>Password </label>
        <input type="password" name="password" placeholder="Enter your password" onpaste="return false;" oncontextmenu="return false;">
        <button id="signInBtn" type="submit" disabled="">
          <span>Sign In Now</span>
        </button>
      </form>
    `);

    await page.evaluate(() => {
      const form = document.querySelector("#loginForm");
      const phone = document.querySelector('input[name="phone"]');
      const pass = document.querySelector('input[name="password"]');
      const btn = document.querySelector("#signInBtn");

      const checkValidity = () => {
        if (phone.value.length > 5 && pass.value.length > 5) {
          btn.removeAttribute("disabled");
        } else {
          btn.setAttribute("disabled", "");
        }
      };

      phone.addEventListener("input", checkValidity);
      pass.addEventListener("input", checkValidity);
      phone.addEventListener("change", checkValidity);
      pass.addEventListener("change", checkValidity);

      form.addEventListener("submit", (e) => {
        e.preventDefault();
        window.signedIn = true;
        document.body.innerHTML = '<h1>Verify OTP</h1><label for="otp">OTP</label><input id="otp" type="text">';
      });
    });

    const questions = [];
    const prompts = {
      async question(message) {
        questions.push(message);
        return "";
      },
    };

    const credentials = {
      contactNumber: "01934957333",
      password: "Pass2026$",
    };

    await runGuidedBookingFlow(page, prompts, credentials);

    assert.equal(await page.evaluate(() => Boolean(window.signedIn)), true, "Sign In Now was submitted");
    assert.ok(questions.some((q) => q.startsWith("Enter the OTP in the browser")), "advanced to the OTP step");
  } finally {
    await browser.close();
  }
});
