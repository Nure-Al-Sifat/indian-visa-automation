import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "patchright";
import { confirmMissionAndCentre, detectPortalPage, dismissPortalNotices, fileMatchesPerson, isSuccessNotice, planApplicantUploads, readPortalNotifications, readUploadedPrimaryName, runGuidedBookingFlow, selectCalendarDateAndContinue } from "../src/booking.js";

test("continues from an already signed-in dashboard without waiting for login", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <p>Your Contact Number: 01900000000</p>
      <button>Logout</button>
      <button id="take">Take Your Appointment</button>
    `);
    await page.locator("#take").evaluate((button) => button.addEventListener("click", () => {
      document.body.innerHTML = '<h1>To book your visa appointment</h1><button id="next">Next Step</button>';
      document.querySelector("#next").addEventListener("click", () => {
        window.nextStepClicked = true;
        document.body.innerHTML = '<h2>Upload Primary Applicant Webfile</h2><input type="file">';
      });
    }));

    const questions = [];
    const prompts = {
      async question(message) {
        questions.push(message);
        if (message.startsWith("How many applicants")) return "1";
        return "";
      },
    };

    await runGuidedBookingFlow(page, prompts);

    assert.equal(await page.evaluate(() => Boolean(window.nextStepClicked)), true, "continues through Next Step");
    assert.ok(questions.some((message) => message.startsWith("How many applicants")), "reaches the Webfile upload step");
    assert.equal(questions.some((message) => /sign in|otp/i.test(message)), false, "does not ask for login or OTP");
  } finally {
    await browser.close();
  }
});

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

test("skips sign-in and Take Your Appointment if already at the Next Step booking guide page", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <h1>To book your visa appointment</h1>
      <button id="next">Next Step</button>
    `);
    await page.locator("#next").evaluate((button) => button.addEventListener("click", () => {
      window.nextStepClicked = true;
      document.body.innerHTML = '<h2>Upload Primary Applicant Webfile</h2><input type="file">';
    }));

    const questions = [];
    const prompts = {
      async question(message) {
        questions.push(message);
        if (message.startsWith("How many applicants")) return "1";
        return "";
      },
    };

    await runGuidedBookingFlow(page, prompts);

    assert.equal(await page.evaluate(() => Boolean(window.nextStepClicked)), true, "continues through Next Step");
    assert.ok(questions.some((message) => message.startsWith("How many applicants")), "reaches the Webfile upload step");
    assert.equal(questions.some((message) => /sign in|otp/i.test(message)), false, "does not ask for login or OTP");
  } finally {
    await browser.close();
  }
});

test("accurately handles live IVAC Webfile upload with hidden inputs, dangling inputs, applicant counter, and Confirm button", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ivac-booking-live-test-"));
  const primaryPdf = path.join(tempDir, "primary-webfile.pdf");
  const secondaryPdf = path.join(tempDir, "secondary-webfile.pdf");
  try {
    await writeFile(primaryPdf, "%PDF-1.4\nmock primary Webfile\n");
    await writeFile(secondaryPdf, "%PDF-1.4\nmock secondary Webfile\n");
    const page = await browser.newPage();
    await page.setContent(`
      <div id="root">
        <header><button>Logout</button></header>
        <main>
          <div class="space-y-4">
            <div class="text-2xl font-bold"><p>Total number of applicants: <span class="text-orange">0</span></p></div>
            <div class="w-full">
              <div class="border-dashed cursor-pointer">
                <label>Upload Primary Applicant's Webfile<span class="text-red-500 ml-1">*</span></label>
              </div>
              <input type="file" accept=".pdf,application/pdf" class="hidden">
            </div>
            <div id="cf-turnstile">
              <input type="hidden" name="cf-turnstile-response" value="mock-token-abc-123">
            </div>
            <button class="bg-[#FF671F]" disabled="" type="button">
              <span>Confirm All Information is Correct</span>
            </button>
            <input type="file" accept=".pdf,application/pdf" class="hidden">
          </div>
        </main>
      </div>
    `);

    await page.evaluate(() => {
      const primaryInput = document.querySelectorAll('input[type="file"]')[0];
      const counter = document.querySelector('.text-orange');
      const confirmBtn = document.querySelector('button[type="button"]');

      primaryInput.addEventListener('change', () => {
        counter.textContent = '1';
        const addBtn = document.createElement('button');
        addBtn.textContent = 'Add Applicant';
        addBtn.addEventListener('click', () => {
          const secDiv = document.createElement('div');
          secDiv.className = 'w-full';
          secDiv.innerHTML = `
            <div class="border-dashed cursor-pointer">
              <label>Upload Secondary Applicant 2's Webfile*</label>
            </div>
            <input type="file" accept=".pdf,application/pdf" class="hidden">
          `;
          const secInput = secDiv.querySelector('input');
          secInput.addEventListener('change', () => {
            counter.textContent = '2';
            confirmBtn.removeAttribute('disabled');
          });
          document.querySelector('.space-y-4').insertBefore(secDiv, confirmBtn);
        });
        document.querySelector('.space-y-4').insertBefore(addBtn, confirmBtn);
      });

      confirmBtn.addEventListener('click', () => {
        window.confirmed = true;
        document.body.innerHTML = `
          <label for="centre">Select IVAC Centre</label>
          <select id="centre">
            <option value="" disabled>Select Centre</option>
            <option value="dhaka">Dhaka</option>
          </select>
          <label for="date">Appointment Date</label><input id="date" type="date">
          <button id="submit">Proceed to Payment</button>
        `;
        document.querySelector('#submit').addEventListener('click', () => {
          document.body.innerHTML = '<h1>Payment Details</h1><button>Pay Now</button>';
        });
      });
    });

    const questions = [];
    const prompts = {
      async question(message) {
        questions.push(message);
        if (message.startsWith("How many applicants")) return "2";
        if (message.startsWith("Path to Primary Applicant")) return primaryPdf;
        if (message.startsWith("Path to Secondary Applicant 2")) return secondaryPdf;
        if (message.startsWith("Upload these 2 original PDF")) return "y";
        if (message.startsWith("Confirm the 2 applicant Webfiles")) return "y";
        if (message.startsWith("Preferred available date")) return "2026-11-20";
        if (message.startsWith("Submit the appointment selection")) return "y";
        return "";
      },
    };

    await runGuidedBookingFlow(page, prompts);

    assert.equal(await page.evaluate(() => Boolean(window.confirmed)), true, "Confirm All Information is Correct was clicked");
    assert.equal(await page.locator("h1").innerText(), "Payment Details", "reached payment step safely");
  } finally {
    await browser.close();
  }
});

test("handles end-to-end flow: mission/centre -> waiting room -> time-slot -> declaration -> payment stop", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ivac-booking-e2e-"));
  const primaryPdf = path.join(tempDir, "primary-webfile.pdf");
  try {
    await writeFile(primaryPdf, "%PDF-1.4\nmock primary Webfile for e2e test\n");
    const page = await browser.newPage();
    await page.setContent(`
      <div id="root">
        <header><button>Logout</button></header>
        <main>
          <div class="space-y-4">
            <p>Total number of applicants: <span class="text-orange">0</span></p>
            <div class="border-dashed cursor-pointer">
              <label>Upload Primary Applicant's Webfile*</label>
            </div>
            <input type="file" accept=".pdf,application/pdf" class="hidden">
            <button id="confirm-docs" type="button" disabled="">
              <span>Confirm All Information is Correct</span>
            </button>
          </div>
        </main>
      </div>
    `);

    await page.evaluate(() => {
      const primaryInput = document.querySelector('input[type="file"]');
      const counter = document.querySelector('.text-orange');
      const confirmDocs = document.querySelector('#confirm-docs');

      primaryInput.addEventListener('change', () => {
        counter.textContent = '1';
        confirmDocs.removeAttribute('disabled');
      });

      confirmDocs.addEventListener('click', () => {
        // Step: /appointment/mission
        document.body.innerHTML = `
          <div id="mission-page">
            <h2>Select IVAC Mission / Centre</h2>
            <select id="mission" name="mission">
              <option value="" disabled>Select Centre</option>
              <option value="dhaka">Dhaka</option>
              <option value="sylhet">Sylhet</option>
            </select>
            <button id="mission-continue">Continue</button>
          </div>
        `;
        document.querySelector('#mission-continue').addEventListener('click', () => {
          // Step: /appointment/waiting
          document.body.innerHTML = `
            <div id="waiting-page">
              <h1>Waiting for booking portal to open...</h1>
              <p>Countdown: 00:00:01</p>
            </div>
          `;
          window.waitingRoomReached = true;
          // Simulate slot release after 400ms
          setTimeout(() => {
            // Step: /appointment/time-slot
            document.body.innerHTML = `
              <div id="timeslot-page">
                <h2>Select Appointment Date & Time</h2>
                <select id="date-select">
                  <option value="" disabled>Select Date</option>
                  <option value="2026-11-25">2026-11-25 (Available)</option>
                </select>
                <button class="slot-time">10:00 AM</button>
                <button id="slot-continue">Continue</button>
              </div>
            `;
            window.timeSlotReached = true;
            document.querySelector('#slot-continue').addEventListener('click', () => {
              // Step: /appointment/declaration
              document.body.innerHTML = `
                <div id="declaration-page">
                  <h2>Declaration</h2>
                  <label for="decl-check">
                    <input id="decl-check" type="checkbox">
                    I consent to the appointment terms and declaration
                  </label>
                  <button id="decl-continue">Proceed to Payment</button>
                </div>
              `;
              window.declarationReached = true;
              document.querySelector('#decl-continue').addEventListener('click', () => {
                // Step: /appointment/continue-payment -> /appointment/confirm-payment
                document.body.innerHTML = `
                  <div id="payment-page">
                    <h1>Payment Details</h1>
                    <p>Total Fee: 800 BDT</p>
                    <button id="pay-now">Pay Now</button>
                  </div>
                `;
                window.paymentStepReached = true;
              });
            });
          }, 400);
        });
      });
    });

    const questions = [];
    const prompts = {
      async question(message) {
        questions.push(message);
        if (message.startsWith("How many applicants")) return "1";
        if (message.startsWith("Path to Primary Applicant")) return primaryPdf;
        if (message.startsWith("Upload these 1 original PDF")) return "y";
        if (message.startsWith("Confirm the 1 applicant Webfile")) return "y";
        if (message.startsWith("Choose the preferred centre")) return "1";
        if (message.startsWith("Preferred available date")) return "2026-11-25";
        if (message.startsWith("Do you agree to this consent")) return "y";
        if (message.startsWith("Submit the appointment selection")) return "y";
        return "";
      },
    };

    await runGuidedBookingFlow(page, prompts);

    assert.equal(await page.evaluate(() => Boolean(window.waitingRoomReached)), true, "reached waiting room");
    assert.equal(await page.evaluate(() => Boolean(window.timeSlotReached)), true, "advanced from waiting room to time-slot");
    assert.equal(await page.evaluate(() => Boolean(window.declarationReached)), true, "reached declaration step");
    assert.equal(await page.evaluate(() => Boolean(window.paymentStepReached)), true, "reached payment step");
    assert.equal(await page.locator("#pay-now").isVisible(), true, "safely stopped at payment without submitting payment");
  } finally {
    await browser.close();
    await unlink(primaryPdf).catch(() => {});
    await rmdir(tempDir).catch(() => {});
  }
});

test("accurately handles live IVAC single reusable dropzone across multiple applicants without Add Applicant button", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ivac-booking-reusable-dropzone-"));
  const primaryPdf = path.join(tempDir, "primary-webfile.pdf");
  const secondary2Pdf = path.join(tempDir, "secondary2-webfile.pdf");
  const secondary3Pdf = path.join(tempDir, "secondary3-webfile.pdf");
  try {
    await writeFile(primaryPdf, "%PDF-1.4\nmock primary Webfile\n");
    await writeFile(secondary2Pdf, "%PDF-1.4\nmock secondary 2 Webfile\n");
    await writeFile(secondary3Pdf, "%PDF-1.4\nmock secondary 3 Webfile\n");
    const page = await browser.newPage();
    await page.setContent(`
      <div id="root">
        <header><button>Logout</button></header>
        <main>
          <div class="space-y-4">
            <div class="text-2xl font-bold"><p>Total number of applicants: <span class="text-orange">0</span></p></div>
            <div class="w-full">
              <div class="border-dashed cursor-pointer">
                <label id="dropzone-label">Upload Primary Applicant's Webfile<span class="text-red-500 ml-1">*</span></label>
              </div>
              <input id="reusable-file-input" type="file" accept=".pdf,application/pdf" class="hidden">
            </div>
            <div id="cf-turnstile">
              <input type="hidden" name="cf-turnstile-response" id="turnstile-token" value="initial-token-1">
            </div>
            <button id="confirm-all-btn" class="bg-[#FF671F]" disabled="" type="button">
              <span>Confirm All Information is Correct</span>
            </button>
            <input type="file" accept=".pdf,application/pdf" class="hidden">
          </div>
        </main>
      </div>
    `);

    await page.evaluate(() => {
      const fileInput = document.querySelector('#reusable-file-input');
      const counter = document.querySelector('.text-orange');
      const label = document.querySelector('#dropzone-label');
      const turnstile = document.querySelector('#turnstile-token');
      const confirmBtn = document.querySelector('#confirm-all-btn');
      let currentApplicants = 0;

      fileInput.addEventListener('change', () => {
        currentApplicants += 1;
        counter.textContent = String(currentApplicants);
        // Live portal behavior: clears input value and updates dropzone label
        fileInput.value = '';
        label.textContent = "Upload Other Applicant's Webfile";
        // Simulate Turnstile refresh
        turnstile.value = `token-for-applicant-${currentApplicants + 1}`;
        if (currentApplicants >= 3) {
          confirmBtn.removeAttribute('disabled');
        }
      });

      confirmBtn.addEventListener('click', () => {
        window.reusableDropzoneConfirmed = true;
        document.body.innerHTML = `
          <label for="centre">Select IVAC Centre</label>
          <select id="centre">
            <option value="" disabled>Select Centre</option>
            <option value="dhaka">Dhaka</option>
          </select>
          <label for="date">Appointment Date</label><input id="date" type="date">
          <button id="submit">Proceed to Payment</button>
        `;
        document.querySelector('#submit').addEventListener('click', () => {
          document.body.innerHTML = '<h1>Payment Details</h1><button>Pay Now</button>';
        });
      });
    });

    const prompts = {
      async question(message) {
        if (message.startsWith("How many applicants")) return "3";
        if (message.startsWith("Path to Primary Applicant")) return primaryPdf;
        if (message.startsWith("Path to Secondary Applicant 2")) return secondary2Pdf;
        if (message.startsWith("Path to Secondary Applicant 3")) return secondary3Pdf;
        if (message.startsWith("Upload these 3 original PDF")) return "y";
        if (message.startsWith("Confirm the 3 applicant Webfiles")) return "y";
        if (message.startsWith("Preferred available date")) return "2026-11-20";
        if (message.startsWith("Submit the appointment selection")) return "y";
        return "";
      },
    };

    await runGuidedBookingFlow(page, prompts);

    assert.equal(await page.evaluate(() => Boolean(window.reusableDropzoneConfirmed)), true, "Confirm All Information is Correct was clicked");
    assert.equal(await page.locator("h1").innerText(), "Payment Details", "reached payment step safely with 3 applicants");
  } finally {
    await browser.close();
    await unlink(primaryPdf).catch(() => {});
    await unlink(secondary2Pdf).catch(() => {});
    await unlink(secondary3Pdf).catch(() => {});
    await rmdir(tempDir).catch(() => {});
  }
});

test("confirms the live Mission & IVAC Center page built from custom dropdown buttons", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <div class="animate-marquee">• Do not share OTP, login credentials. • Please keep your payment method ready.</div>
      <form>
        <div><button type="button" disabled onclick="window.missionClicked = true">
          <div><span>Select a mission</span><span>Dhaka</span></div></button></div>
        <div><button type="button" onclick="window.centrePickerClicked = true">
          <div><span>Select your IVAC center</span><span>IVAC, Dhaka (JFP)</span></div></button></div>
        <p>Please ensure you select the correct mission and IVAC center for your appointment.</p>
        <button type="submit"><span>Confirm Mission &amp; IVAC Center</span><span>→</span></button>
      </form>
    `);
    await page.locator("form").evaluate((form) => form.addEventListener("submit", (event) => {
      event.preventDefault();
      window.confirmClicked = true;
      document.body.innerHTML = '<h2>Select Appointment Date</h2><input type="date">';
    }));

    const centre = await confirmMissionAndCentre(page);

    assert.equal(centre, "IVAC, Dhaka (JFP)");
    assert.equal(await page.evaluate(() => Boolean(window.confirmClicked)), true, "clicks Confirm Mission & IVAC Center");
    assert.equal(await page.evaluate(() => Boolean(window.missionClicked)), false, "never clicks the disabled mission picker");
    assert.equal(await page.evaluate(() => Boolean(window.centrePickerClicked)), false, "does not reopen the centre picker");
  } finally {
    await browser.close();
  }
});

test("confirmMissionAndCentre ignores pages without the mission confirm button", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent("<h2>Select Appointment Date</h2><input type=\"date\">");
    assert.equal(await confirmMissionAndCentre(page), undefined);
  } finally {
    await browser.close();
  }
});

function liveCalendarMarkup({ enabledDays, turnstileValue = "" }) {
  const days = Array.from({ length: 30 }, (_, i) => i + 1).map((day) =>
    `<div><button type="button" ${enabledDays.includes(day) ? "" : 'disabled=""'} class="day">${day}</button></div>`,
  ).join("");
  return `
    <div class="animate-marquee">• Do not share OTP, login credentials. • Please keep your payment method ready.</div>
    <p>Select an Appointment Date</p><p>Pick up a date</p>
    <div>
      <button type="button" aria-label="Previous month">‹</button>
      <div><span>November 2026</span></div>
      <button type="button" aria-label="Next month">›</button>
    </div>
    <div class="grid">${days}</div>
    <button>Your appointment time will be provided in the Payment Invoice.</button>
    <div id="cf-turnstile"><input type="hidden" name="cf-turnstile-response" value="${turnstileValue}"></div>
    <button id="continue-booking" disabled=""><span>Continue Booking</span><span>→</span></button>
  `;
}

test("picks a random available calendar date and clicks Continue Booking on the live time-slot page", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(liveCalendarMarkup({ enabledDays: [18, 19], turnstileValue: "token" }));
    await page.evaluate(() => {
      document.querySelectorAll("button.day").forEach((button) => button.addEventListener("click", () => {
        window.pickedDay = button.textContent.trim();
        document.querySelector("#continue-booking").removeAttribute("disabled");
      }));
      document.querySelector("#continue-booking").addEventListener("click", () => {
        window.continueClicked = true;
        document.body.innerHTML = "<h2>Declaration</h2>";
      });
    });

    const result = await selectCalendarDateAndContinue(page, { random: () => 0.99 });

    assert.equal(await page.evaluate(() => window.pickedDay), "19", "picks among enabled days only");
    assert.equal(result, "19 November 2026");
    assert.equal(await page.evaluate(() => Boolean(window.continueClicked)), true, "clicks Continue Booking");
  } finally {
    await browser.close();
  }
});

test("waits for Turnstile before clicking Continue Booking", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(liveCalendarMarkup({ enabledDays: [18] }));
    await page.evaluate(() => {
      document.querySelector("button.day:not([disabled])").addEventListener("click", () => {
        setTimeout(() => {
          document.querySelector('input[name="cf-turnstile-response"]').value = "token";
          document.querySelector("#continue-booking").removeAttribute("disabled");
        }, 500);
      });
      document.querySelector("#continue-booking").addEventListener("click", () => {
        window.continueClickedWithToken = document.querySelector('input[name="cf-turnstile-response"]').value === "token";
        document.body.innerHTML = "<h2>Declaration</h2>";
      });
    });

    const result = await selectCalendarDateAndContinue(page, { random: () => 0 });

    assert.equal(result, "18 November 2026");
    assert.equal(await page.evaluate(() => window.continueClickedWithToken), true);
  } finally {
    await browser.close();
  }
});

test("an unanswered OTP 'press Enter' prompt does not swallow later questions", { timeout: 60_000 }, async () => {
  const { PassThrough } = await import("node:stream");
  const readline = await import("node:readline/promises");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const input = new PassThrough();
  const rl = readline.createInterface({ input, output: new PassThrough() });
  try {
    const page = await browser.newPage();
    await page.setContent(`
      <h2>OTP Verification</h2><p>Verify OTP</p>
      <input autocomplete="one-time-code"><button>Verify OTP</button>
    `);
    // The user enters the OTP in the browser and never presses Enter in the terminal.
    await page.evaluate(() => setTimeout(() => {
      document.body.innerHTML = '<button>Logout</button><h2>Upload Primary Applicant Webfile</h2><input type="file">';
    }, 500));

    const asked = [];
    const prompts = {
      question(message, options) {
        asked.push(message);
        const answer = rl.question(message, options);
        if (message.startsWith("How many applicants")) setTimeout(() => input.write("1\n"), 50);
        if (message.startsWith("Path to Primary Applicant")) setTimeout(() => input.write("\n"), 50);
        return answer;
      },
    };

    await runGuidedBookingFlow(page, prompts);

    assert.ok(asked.some((message) => /OTP/.test(message)), "showed the optional OTP prompt");
    assert.ok(asked.some((message) => message.startsWith("How many applicants")), "later question was answered");
    assert.ok(asked.some((message) => message.startsWith("Path to Primary Applicant")), "flow kept going after the stale prompt");
  } finally {
    rl.close();
    await browser.close();
  }
});

test("starts directly on the date picker page: picks a date, continues, and stops at payment", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<header><button>Logout</button></header>${liveCalendarMarkup({ enabledDays: [18, 19], turnstileValue: "token" })}`);
    await page.evaluate(() => {
      document.querySelectorAll("button.day").forEach((button) => button.addEventListener("click", () => {
        window.pickedDay = button.textContent.trim();
        document.querySelector("#continue-booking").removeAttribute("disabled");
      }));
      document.querySelector("#continue-booking").addEventListener("click", () => {
        document.body.innerHTML = `
          <h2>Declaration</h2>
          <label><input id="decl" type="checkbox"> I consent to the appointment terms and declaration</label>
          <button id="proceed">Proceed to Payment</button>`;
        document.querySelector("#proceed").addEventListener("click", () => {
          document.body.innerHTML = '<h1>Payment Details</h1><button id="pay-now">Pay Now</button>';
          window.paymentReached = true;
        });
      });
    });

    const questions = [];
    const prompts = {
      async question(message) {
        questions.push(message);
        if (message.startsWith("Do you agree to this consent")) return "y";
        if (message.startsWith("Submit the appointment selection")) return "y";
        return "";
      },
    };

    await runGuidedBookingFlow(page, prompts);

    assert.ok(["18", "19"].includes(await page.evaluate(() => window.pickedDay)), "picked an available date");
    assert.equal(await page.evaluate(() => Boolean(window.paymentReached)), true, "continued to payment");
    assert.equal(questions.some((message) => /how many applicants|preferred available date|sign in|otp/i.test(message)), false,
      `skipped sign-in, uploads and the date question; asked: ${JSON.stringify(questions)}`);
  } finally {
    await browser.close();
  }
});

test("detectPortalPage names each portal page and ignores the notice banner", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const banner = '<div class="animate-marquee">• Do not share OTP, login credentials. • Please keep your payment method ready.</div>';
  const cases = [
    ["dashboard", `${banner}<button>Logout</button><button>Take Your Appointment</button>`],
    ["login", `${banner}<input type="tel" placeholder="Contact number"><input type="password"><button>Sign In</button>`],
    ["otp", '<h2>OTP Verification</h2><input autocomplete="one-time-code"><button>Verify OTP</button>'],
    ["booking-guide", `${banner}<h1>To book your visa appointment</h1><button>Next Step</button>`],
    ["webfile", `${banner}<label>Upload Primary Applicant's Webfile</label><input type="file">`],
    ["mission", `${banner}<button type="submit">Confirm Mission &amp; IVAC Center</button>`],
    ["waiting", `${banner}<h1>Waiting for booking portal to open...</h1>`],
    ["time-slot", liveCalendarMarkup({ enabledDays: [18] })],
    ["declaration", '<h2>Declaration</h2><label><input type="checkbox"> I consent to the declaration</label>'],
    ["payment", `${banner}<h1>Payment Details</h1><button>Pay Now</button>`],
    ["confirmed", "<h1>Your appointment is confirmed</h1><button>Download Invoice</button>"],
    ["unknown", `${banner}<p>Hello</p>`],
  ];
  try {
    const page = await browser.newPage();
    for (const [expected, html] of cases) {
      await page.setContent(html);
      assert.equal((await detectPortalPage(page)).key, expected, `page markup: ${html.slice(0, 80)}`);
    }
  } finally {
    await browser.close();
  }
});

test("recognizes and completes the real IVAC date-picker page (exact portal markup)", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("./fixtures/time-slot-page.html", import.meta.url), "utf8");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html);

    assert.deepEqual(await detectPortalPage(page), { key: "time-slot", label: "Appointment date picker" });

    await page.evaluate(() => {
      const continueButton = [...document.querySelectorAll("button")].find((b) => /Continue Booking/.test(b.textContent));
      document.querySelectorAll('button[type="button"]').forEach((day) => day.addEventListener("click", () => {
        if (/^\s*\d+\s*$/.test(day.textContent)) {
          window.pickedDay = day.textContent.trim();
          continueButton.removeAttribute("disabled");
        }
      }));
      continueButton.addEventListener("click", () => {
        window.continueClicked = true;
        document.body.innerHTML = "<h2>Declaration</h2>";
      });
    });

    const result = await selectCalendarDateAndContinue(page);
    assert.ok(["18", "19"].includes(await page.evaluate(() => window.pickedDay)), "picked 18 or 19, the only enabled days");
    assert.match(result, /^(?:18|19) November 2026$/);
    assert.equal(await page.evaluate(() => Boolean(window.continueClicked)), true);
  } finally {
    await browser.close();
  }
});

test("accurately detects and clicks Save & Continue in live IVAC details confirmation modal", async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ivac-booking-modal-"));
  const primaryPdf = path.join(tempDir, "01 primary-webfile.pdf");
  const secondary2Pdf = path.join(tempDir, "02 secondary2-webfile.pdf");
  const secondary3Pdf = path.join(tempDir, "03 secondary3-webfile.pdf");

  try {
    await writeFile(primaryPdf, "%PDF-1.4 mock pdf");
    await writeFile(secondary2Pdf, "%PDF-1.4 mock pdf");
    await writeFile(secondary3Pdf, "%PDF-1.4 mock pdf");

    const page = await browser.newPage();
    await page.setContent(`
      <div id="root">
        <header><a href="/profile">Profile</a></header>
        <main>
          <div class="text-2xl font-bold text-gray-500">
            <p>Total number of applicants: <span class="text-orange">3</span></p>
          </div>
          <div><span>Primary Applicant</span><span>PARIMAL CHOWDHURY</span></div>
          <div><span>Applicant 02</span><span>MENOTY CHOWDHURY</span></div>
          <div><span>Applicant 03</span><span>MD ALAMIN</span></div>
          <input type="file" accept=".pdf,application/pdf" class="hidden">
          <button id="confirm-all-btn" class="bg-[#FF671F]" disabled="" type="button">
            <span>Confirm All Information is Correct</span>
          </button>
          <!-- Live IVAC Confirmation Modal -->
          <div class="fixed inset-0 z-50 flex items-center justify-center p-4" id="details-modal">
            <div class="relative w-full max-w-[693px] bg-white rounded-3xl p-8 shadow-2xl">
              <h2>Please confirm your details</h2>
              <p>Make sure all the information is correct before saving and continuing.</p>
              <button id="save-continue-btn" class="bg-[#FF671F] w-full flex items-center justify-center" type="button">
                <span>Save & Continue</span>
              </button>
              <button id="go-back-btn">Go Back</button>
            </div>
          </div>
        </main>
      </div>
    `);

    await page.evaluate(() => {
      const saveBtn = document.querySelector("#save-continue-btn");
      saveBtn.addEventListener("click", () => {
        window.saveAndContinueClicked = true;
        // Simulate navigation to IVAC Centre selection
        document.body.innerHTML = `
          <label for="centre">Select IVAC Centre</label>
          <select id="centre">
            <option value="" disabled>Select Centre</option>
            <option value="dhaka">Dhaka</option>
          </select>
          <label for="date">Appointment Date</label><input id="date" type="date">
          <button id="submit">Proceed to Payment</button>
        `;
        document.querySelector("#submit").addEventListener("click", () => {
          document.body.innerHTML = '<h1>Payment Details</h1><button>Pay Now</button>';
        });
      });
    });

    const prompts = {
      async question(message) {
        if (message.startsWith("How many applicants")) return "3";
        if (message.startsWith("Path to Primary Applicant")) return primaryPdf;
        if (message.startsWith("Path to Secondary Applicant 2")) return secondary2Pdf;
        if (message.startsWith("Path to Secondary Applicant 3")) return secondary3Pdf;
        if (message.startsWith("Upload these 3 original PDF")) return "y";
        if (message.startsWith("Confirm the 3 applicant Webfiles")) return "y";
        if (message.startsWith("Preferred available date")) return "2026-11-20";
        if (message.startsWith("Submit the appointment selection")) return "y";
        return "";
      },
    };

    await runGuidedBookingFlow(page, prompts);

    assert.equal(await page.evaluate(() => Boolean(window.saveAndContinueClicked)), true, "Save & Continue was clicked");
    assert.equal(await page.locator("h1").innerText(), "Payment Details", "reached payment step safely from modal");
  } finally {
    await browser.close();
    await unlink(primaryPdf).catch(() => {});
    await unlink(secondary2Pdf).catch(() => {});
    await unlink(secondary3Pdf).catch(() => {});
    await rmdir(tempDir).catch(() => {});
  }
});

test("scrolls the Cloudflare widget into view so it can solve, then picks a date and continues", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
    // Like the live portal: the Turnstile widget sits far below the calendar
    // and only produces a token once it is actually visible on screen.
    const markup = liveCalendarMarkup({ enabledDays: [18, 19] })
      .replace('<div id="cf-turnstile">', '<div style="height: 2500px"></div><div id="cf-turnstile" style="height: 65px; width: 300px">');
    await page.setContent(markup);
    await page.evaluate(() => {
      const widget = document.querySelector("#cf-turnstile");
      const token = widget.querySelector('input[name="cf-turnstile-response"]');
      const continueButton = document.querySelector("#continue-booking");
      const maybeEnable = () => {
        if (window.pickedDay && token.value) continueButton.removeAttribute("disabled");
      };
      new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setTimeout(() => { token.value = "solved-after-scroll"; maybeEnable(); }, 300);
        }
      }).observe(widget);
      document.querySelectorAll("button.day").forEach((day) => day.addEventListener("click", () => {
        window.pickedDay = day.textContent.trim();
        maybeEnable();
      }));
      continueButton.addEventListener("click", () => {
        window.continueClicked = true;
        document.body.innerHTML = "<h2>Declaration</h2>";
      });
    });

    const result = await selectCalendarDateAndContinue(page, { timeout: 20_000 });

    assert.ok(["18", "19"].includes(await page.evaluate(() => window.pickedDay)), "picked an available date");
    assert.match(String(result), /^(?:18|19) November 2026$/);
    assert.equal(await page.evaluate(() => Boolean(window.continueClicked)), true, "clicked Continue Booking after Turnstile solved");
  } finally {
    await browser.close();
  }
});

test("portal success notifications are not treated as errors (seen live after Sign In)", () => {
  assert.equal(isSuccessNotice("Notification OTP sent successfully!A verification code has been sent to your registered mobile number."), true);
  assert.equal(isSuccessNotice("Webfile uploaded successfully"), true);
  assert.equal(isSuccessNotice("Upload failed. Please try again"), false);
  assert.equal(isSuccessNotice("Invalid OTP"), false);
  assert.equal(isSuccessNotice("Too many requests, verification code not sent"), false);
});

test("when the portal says 'File already exists', resumes the saved booking at the date picker (seen live)", { timeout: 90_000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ivac-file-exists-"));
  const primaryPdf = path.join(tempDir, "primary.pdf");
  try {
    await writeFile(primaryPdf, "%PDF-1.4\nmock primary\n");
    const page = await browser.newPage();
    const visited = [];
    const uploadPage = `<!doctype html><body>
      <header><button>Logout</button></header>
      <p>Total number of applicants: <span class="text-orange">0</span></p>
      <div class="border-dashed"><label>Upload Primary Applicant's Webfile*</label></div>
      <input type="file" accept=".pdf,application/pdf" class="hidden">
      <button id="confirm" type="button" disabled>Confirm All Information is Correct</button>
      <ol id="toasts"></ol>
      <script>
        document.querySelector('input[type=file]').addEventListener('change', () => {
          setTimeout(() => { document.querySelector('#toasts').innerHTML = '<li role="status">File already exists.. Try again</li>'; }, 300);
        });
      </script></body>`;
    const timeSlotPage = `<!doctype html><body><header><button>Logout</button></header>
      ${liveCalendarMarkup({ enabledDays: [18, 19], turnstileValue: "token" })}
      <script>
        document.querySelectorAll('button.day').forEach((b) => b.addEventListener('click', () => {
          document.documentElement.dataset.pickedDay = b.textContent.trim();
          document.querySelector('#continue-booking').removeAttribute('disabled');
        }));
        document.querySelector('#continue-booking').addEventListener('click', () => {
          document.body.innerHTML = '<h1>Payment Details</h1><button>Pay Now</button>';
          document.documentElement.dataset.paymentReached = "yes";
        });
      </script></body>`;
    await page.route("https://ivac.test/**", (route) => {
      const { pathname } = new URL(route.request().url());
      visited.push(pathname);
      const body = pathname === "/appointment/time-slot" ? timeSlotPage : uploadPage;
      return route.fulfill({ status: 200, contentType: "text/html", body });
    });
    await page.goto("https://ivac.test/appointment/file-upload");

    const prompts = {
      async question(message) {
        if (message.startsWith("How many applicants")) return "1";
        if (message.startsWith("Path to Primary Applicant")) return primaryPdf;
        if (message.startsWith("Upload these 1 original PDF")) return "y";
        return "";
      },
    };

    await runGuidedBookingFlow(page, prompts);

    assert.ok(visited.includes("/appointment/time-slot"), `opened the saved date-picker step; visited ${JSON.stringify(visited)}`);
    const state = await page.evaluate(() => ({ pickedDay: document.documentElement.dataset.pickedDay, paymentReached: document.documentElement.dataset.paymentReached, url: location.pathname, body: document.body.innerText.slice(0, 80) }));
    assert.ok(["18", "19"].includes(state.pickedDay), `picked an available date; page state ${JSON.stringify(state)}`);
    assert.equal(state.paymentReached, "yes", "continued to payment");
  } finally {
    await browser.close();
    await unlink(primaryPdf).catch(() => {});
    await rmdir(tempDir).catch(() => {});
  }
});

function emptyMissionPageMarkup() {
  // Mirrors the live /appointment/mission page seen after a resumed booking:
  // nothing selected, and option lists that only exist after a click.
  return `<form>
    <div><button type="button" id="mission-btn"><div><span>Select a mission</span><span id="mission-val">Select mission</span></div></button></div>
    <div><button type="button" id="centre-btn" disabled><div><span>Select your IVAC center</span><span id="centre-val">Please select a mission first</span></div></button></div>
    <p>Please ensure you select the correct mission and IVAC center for your appointment.</p>
    <button type="submit"><span>Confirm Mission &amp; IVAC Center</span></button>
  </form>
  <div id="portal"></div>
  <script>
    const portal = document.querySelector('#portal');
    const openList = (items, onPick) => {
      portal.innerHTML = '<ul>' + items.map((item) => '<li class="cursor-pointer">' + item + '</li>').join('') + '</ul>';
      portal.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => { portal.innerHTML = ''; onPick(li.textContent); }));
    };
    document.querySelector('#mission-btn').addEventListener('click', () => openList(['Dhaka', 'Chattogram', 'Rajshahi'], (value) => {
      document.querySelector('#mission-val').textContent = value;
      document.querySelector('#centre-btn').removeAttribute('disabled');
      document.querySelector('#centre-val').textContent = 'Select IVAC center';
    }));
    document.querySelector('#centre-btn').addEventListener('click', () => openList(['IVAC, Dhaka (JFP)'], (value) => {
      document.querySelector('#centre-val').textContent = value;
    }));
    document.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      document.documentElement.dataset.confirmed = document.querySelector('#mission-val').textContent + ' / ' + document.querySelector('#centre-val').textContent;
      document.body.innerHTML = '<p>Select an Appointment Date</p><button id="continue-booking" disabled>Continue Booking</button>';
    });
  </script>`;
}

test("picks Mission and IVAC Center from the portal's click-to-open lists (asks once when there are several)", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://ivac.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><body>${emptyMissionPageMarkup()}</body>` }));
    await page.goto("https://ivac.test/appointment/mission");

    const asked = [];
    const prompts = { async question(message) { asked.push(message); return message.startsWith("Mission number") ? "1" : ""; } };
    const preferences = {};
    const centre = await confirmMissionAndCentre(page, 20_000, { prompts, preferences });

    assert.equal(centre, "IVAC, Dhaka (JFP)");
    assert.deepEqual(asked, ["Mission number: "], "asked only for the mission (3 options); the single centre was picked automatically");
    assert.deepEqual(preferences, { mission: "Dhaka", centre: "IVAC, Dhaka (JFP)" });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.confirmed), "Dhaka / IVAC, Dhaka (JFP)");
  } finally {
    await browser.close();
  }
});

test("uses the remembered Mission choice without asking again", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://ivac.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><body>${emptyMissionPageMarkup()}</body>` }));
    await page.goto("https://ivac.test/appointment/mission");

    const asked = [];
    const prompts = { async question(message) { asked.push(message); return ""; } };
    const centre = await confirmMissionAndCentre(page, 20_000, { prompts, preferences: { mission: "Dhaka" } });

    assert.equal(centre, "IVAC, Dhaka (JFP)");
    assert.deepEqual(asked, [], "no questions");
  } finally {
    await browser.close();
  }
});

test("reads the Primary already on the portal and plans the rest as other applicants (seen live)", () => {
  const livePageText = "Total number of applicants: 1\nPrimary Applicant\nSUMALA MONDAL\nUpload Other Applicant's Webfile\nMaximum file size: 500KB";
  assert.equal(readUploadedPrimaryName(livePageText), "SUMALA MONDAL");
  assert.equal(readUploadedPrimaryName("Total number of applicants: 0\nUpload Primary Applicant's Webfile *"), "");

  assert.equal(fileMatchesPerson("doc_file/01 BGDDW70BEF26PA690503 PARIMAL.pdf", "SUMALA MONDAL"), false);
  assert.equal(fileMatchesPerson("doc_file/01 BGDDW70BEF26PA690503 SUMALA.pdf", "SUMALA MONDAL"), true);
  assert.equal(fileMatchesPerson("doc_file/02 BGDDW5783326ME790925.pdf", "SUMALA MONDAL"), true, "no name in file: assume it matches");

  const files = [
    { path: "doc_file/01 BGDDW70BEF26PA690503 PARIMAL.pdf", label: "Primary Applicant" },
    { path: "doc_file/02 BGDDW5783326ME790925.pdf", label: "Secondary Applicant 2" },
    { path: "doc_file/03 BGDDW6259126MD980322.pdf", label: "Secondary Applicant 3" },
  ];
  const plan = planApplicantUploads(files, livePageText);
  assert.equal(plan.primaryOnPortal, "SUMALA MONDAL");
  assert.equal(plan.applicants.length, 4);
  assert.equal(plan.applicants[0].existing, true);
  assert.deepEqual(plan.applicants.slice(1).map((item) => item.path), files.map((item) => item.path));

  assert.equal(planApplicantUploads(files, "Total number of applicants: 0").applicants, files, "no Primary yet: unchanged");
});

test("uploads all PDFs as other applicants when the portal already has a different Primary, retrying a failed upload", { timeout: 300_000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ivac-other-applicants-"));
  const files = ["01 BGDDW70BEF26PA690503 PARIMAL.pdf", "02 BGDDW5783326ME790925.pdf", "03 BGDDW6259126MD980322.pdf"].map((name) => path.join(tempDir, name));
  try {
    for (const file of files) await writeFile(file, "%PDF-1.4\nmock\n");
    const page = await browser.newPage();
    // Like the live portal: the server keeps the applicant list (so a reload
    // shows it), the page has one reusable dropzone, and the first attempt at
    // the second file is lost once, to exercise the retry.
    const stored = ["SUMALA MONDAL"];
    const sent = [];
    let failedOnce = false;
    const calendar = liveCalendarMarkup({ enabledDays: [18], turnstileValue: "token" });
    const uploadPage = () => `<!doctype html><body>
      <header><button>Logout</button></header>
      <p>Total number of applicants: <span class="text-orange">${stored.length}</span></p>
      <div>${stored.map((name, index) => index === 0 ? "<div><span>Primary Applicant</span><br><span>" + name + "</span></div>" : "<div>Applicant 0" + (index + 1) + " " + name + "</div>").join("")}</div>
      <div class="border-dashed"><label>Upload Other Applicant's Webfile</label></div>
      <input type="file" accept=".pdf,application/pdf" class="hidden">
      <button id="confirm" type="button">Confirm All Information is Correct</button>
      <script>
        const input = document.querySelector("input[type=file]");
        input.addEventListener("change", async () => {
          const name = input.files[0].name;
          input.value = "";
          const answer = await fetch("/api/upload?name=" + encodeURIComponent(name), { method: "POST" }).then((r) => r.json());
          if (answer.stored) {
            const count = document.querySelector(".text-orange");
            count.textContent = String(answer.count);
          }
        });
        document.querySelector("#confirm").addEventListener("click", () => {
          document.documentElement.dataset.confirmedCount = document.querySelector(".text-orange").textContent;
          document.body.innerHTML = ${JSON.stringify(calendar)};
          document.querySelector("button.day:not([disabled])").addEventListener("click", () => document.querySelector("#continue-booking").removeAttribute("disabled"));
          document.querySelector("#continue-booking").addEventListener("click", () => { document.body.innerHTML = "<h1>Payment Details</h1><button>Pay Now</button>"; });
        });
      </script></body>`;
    await page.route("https://ivac.test/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/upload") {
        const name = url.searchParams.get("name");
        sent.push(name.slice(0, 2));
        if (name.startsWith("02") && !failedOnce) {
          failedOnce = true;
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ stored: false }) });
        }
        stored.push(name);
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ stored: true, count: stored.length }) });
      }
      return route.fulfill({ status: 200, contentType: "text/html", body: uploadPage() });
    });
    await page.goto("https://ivac.test/appointment/file-upload");

    const prompts = { async question(message) { return /Does the portal show all|Confirm the/.test(message) ? "y" : ""; } };
    await runGuidedBookingFlow(page, prompts, null, { autoUseDocFolder: true, autoConfirmApplicants: true, docFolder: tempDir });

    assert.deepEqual(stored.slice(1).map((name) => name.slice(0, 2)), ["01", "02", "03"], `uploaded all three as other applicants; sent ${JSON.stringify(sent)}`);
    assert.deepEqual(sent, ["01", "02", "02", "03"], "only the lost upload was sent again");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.confirmedCount), "4", "confirmed with 4 applicants (SUMALA + 3)");
  } finally {
    await browser.close();
    for (const file of files) await unlink(file).catch(() => {});
    await rmdir(tempDir).catch(() => {});
  }
});

// Structure copied from the live /appointment/mission page (18 Nov 2026):
// Mission pre-filled from the Primary Webfile and disabled; the IVAC center
// list opens as <div class="absolute z-50 ..."> next to the picker button, and
// each option is a <button type="button"> inside the form.
function liveMissionPageMarkup() {
  return `<form class="space-y-6">
    <div class="w-full relative"><button type="button" disabled><div><div></div><div><span>Select a mission</span><span>Khulna</span></div></div></button></div>
    <div class="w-full relative" id="centre-wrap"><button type="button" id="centre-btn"><div><div></div><div><span>Select your IVAC center</span><span id="centre-val">Select IVAC center</span></div></div></button></div>
    <div><span>i</span><p>Please ensure you select the correct mission and IVAC center for your appointment. Your selection cannot be changed after submission.</p></div>
    <button type="submit"><span>Confirm Mission &amp; IVAC Center</span><span></span></button>
  </form>
  <script>
    document.querySelector('#centre-btn').addEventListener('click', () => {
      const list = document.createElement('div');
      list.className = 'absolute z-50 w-full mt-2 bg-white rounded-2xl';
      list.innerHTML = '<button type="button" class="w-full px-6 py-4 text-left">IVAC, KHULNA</button>';
      list.querySelector('button').addEventListener('click', (event) => {
        event.preventDefault();
        document.querySelector('#centre-val').textContent = 'IVAC, KHULNA';
        list.remove();
      });
      document.querySelector('#centre-wrap').appendChild(list);
    });
    document.querySelector('form').addEventListener('submit', (event) => {
      event.preventDefault();
      document.documentElement.dataset.confirmed = document.querySelector('#centre-val').textContent;
      document.body.innerHTML = '<p>Select an Appointment Date</p><button id="continue-booking" disabled>Continue Booking</button>';
    });
  </script>`;
}

test("live Mission page: reads the IVAC center list whose options are buttons inside the form", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.route("https://ivac.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><body>${liveMissionPageMarkup()}</body>` }));
    await page.goto("https://ivac.test/appointment/mission");

    const asked = [];
    const prompts = { async question(message) { asked.push(message); return ""; } };
    const centre = await confirmMissionAndCentre(page, 20_000, { prompts, preferences: {} });

    assert.equal(centre, "IVAC, KHULNA");
    assert.deepEqual(asked, [], "single option picked without asking; the pre-filled Mission is left alone");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.confirmed), "IVAC, KHULNA");
  } finally {
    await browser.close();
  }
});

test("retries Continue Booking when the click does nothing (seen live before the booking period opens)", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const html = `<!doctype html><body>${liveCalendarMarkup({ enabledDays: [19], turnstileValue: "token" })}
      <script>
        let clicks = 0;
        const token = document.querySelector('input[name="cf-turnstile-response"]');
        const button = document.querySelector('#continue-booking');
        document.querySelector('button.day:not([disabled])').addEventListener('click', () => button.removeAttribute('disabled'));
        button.addEventListener('click', () => {
          clicks += 1;
          document.documentElement.dataset.clicks = String(clicks);
          if (clicks < 3) {
            // Like the live portal: nothing is sent, Cloudflare restarts, then passes again.
            token.value = '';
            button.setAttribute('disabled', '');
            setTimeout(() => { token.value = 'token-' + clicks; button.removeAttribute('disabled'); }, 400);
            return;
          }
          document.body.innerHTML = '<h1>Payment Details</h1><button>Pay Now</button>';
        });
      </script></body>`;
    await page.route("https://ivac.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    await page.goto("https://ivac.test/appointment/time-slot");

    const result = await selectCalendarDateAndContinue(page, { random: () => 0, timeout: 10_000, retryFor: 40_000, retryEvery: 500 });

    assert.equal(result, "19 November 2026");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.clicks), "3", "clicked again until the portal moved on");
  } finally {
    await browser.close();
  }
});

test("reads the portal's Info toasts and keeps retrying while slots are held (exact live messages)", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const held = "All slots for this date are temporarily held by users completing payment. Please check back shortly.";
    const tooSoon = "Please wait a little longer before trying again.";
    const html = `<!doctype html><body>${liveCalendarMarkup({ enabledDays: [19], turnstileValue: "token" })}
      <section aria-label="Notifications alt+T"><ol id="toasts"></ol></section>
      <script>
        const messages = [${JSON.stringify(held)}, ${JSON.stringify(tooSoon)}];
        let clicks = 0;
        const toasts = document.querySelector('#toasts');
        const button = document.querySelector('#continue-booking');
        document.querySelector('button.day:not([disabled])').addEventListener('click', () => button.removeAttribute('disabled'));
        button.addEventListener('click', () => {
          clicks += 1;
          document.documentElement.dataset.clicks = String(clicks);
          if (clicks <= messages.length) {
            toasts.innerHTML = '<li data-sonner-toast><div>Info</div><div>' + messages[clicks - 1] + '</div></li>';
            setTimeout(() => { toasts.innerHTML = ''; }, 3000);
            return;
          }
          document.body.innerHTML = '<h1>Payment Details</h1><button>Pay Now</button>';
        });
      </script></body>`;
    await page.route("https://ivac.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    await page.goto("https://ivac.test/appointment/time-slot");

    // The toast reader itself, on the live wording.
    await page.evaluate((text) => { document.querySelector('#toasts').innerHTML = '<li data-sonner-toast><div>Info</div><div>' + text + '</div></li>'; }, held);
    assert.deepEqual(await readPortalNotifications(page), [held]);
    await page.evaluate(() => { document.querySelector('#toasts').innerHTML = ''; });

    const result = await selectCalendarDateAndContinue(page, { random: () => 0, timeout: 10_000, retryFor: 45_000, retryEvery: 500 });

    assert.equal(result, "19 November 2026");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.clicks), "3", "kept trying through 'held' and 'wait longer'");
  } finally {
    await browser.close();
  }
});

test("Take Your Appointment jumping straight to the saved date picker continues from there (seen live)", { timeout: 90_000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const calendar = liveCalendarMarkup({ enabledDays: [19], turnstileValue: "token" });
    const dashboard = `<!doctype html><body><header><button>Check Payment Status</button><a href="/profile">Profile</a><button>Logout</button></header>
      <h1>Welcome to Indian Visa Application Center</h1><button id="take">Take Your Appointment</button>
      <script>
        document.querySelector('#take').addEventListener('click', () => {
          history.pushState({}, '', '/appointment/time-slot');
          document.body.innerHTML = ${JSON.stringify(calendar)};
          const button = document.querySelector('#continue-booking');
          document.querySelector('button.day:not([disabled])').addEventListener('click', () => button.removeAttribute('disabled'));
          button.addEventListener('click', () => {
            document.body.innerHTML = '<h1>Payment Details</h1><button>Pay Now</button>';
            document.documentElement.dataset.reachedPayment = 'yes';
          });
        });
      </script></body>`;
    await page.route("https://ivac.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: dashboard }));
    await page.goto("https://ivac.test/");

    const questions = [];
    const prompts = { async question(message) { questions.push(message); return ""; } };
    await runGuidedBookingFlow(page, prompts);

    assert.equal(await page.evaluate(() => document.documentElement.dataset.reachedPayment), "yes", "picked the date and continued to payment");
    assert.equal(questions.some((message) => /how many applicants|path to/i.test(message)), false, "did not try to upload again");
  } finally {
    await browser.close();
  }
});

test("a Continue Booking button that briefly changes is not mistaken for moving on (seen live)", { timeout: 60_000 }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const held = "All slots for this date are temporarily held by users completing payment. Please check back shortly.";
    const html = `<!doctype html><body>${liveCalendarMarkup({ enabledDays: [19], turnstileValue: "token" })}
      <section aria-label="Notifications alt+T"><ol id="toasts"></ol></section>
      <script>
        let clicks = 0;
        const button = document.querySelector('#continue-booking');
        document.querySelector('button.day:not([disabled])').addEventListener('click', () => button.removeAttribute('disabled'));
        button.addEventListener('click', () => {
          clicks += 1;
          document.documentElement.dataset.clicks = String(clicks);
          if (clicks === 1) {
            // Live behaviour: the button text changes while the request runs,
            // then the page stays on the calendar with the "held" message.
            const label = button.querySelector('span');
            label.textContent = 'Processing...';
            setTimeout(() => {
              label.textContent = 'Continue Booking';
              document.querySelector('#toasts').innerHTML = '<li data-sonner-toast><div>Info</div><div>${held}</div></li>';
              setTimeout(() => { document.querySelector('#toasts').innerHTML = ''; }, 2000);
            }, 1200);
            return;
          }
          document.body.innerHTML = '<h1>Payment Details</h1><button>Pay Now</button>';
        });
      </script></body>`;
    await page.route("https://ivac.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: html }));
    await page.goto("https://ivac.test/appointment/time-slot");

    const result = await selectCalendarDateAndContinue(page, { random: () => 0, timeout: 10_000, retryFor: 40_000, retryEvery: 500 });

    assert.equal(result, "19 November 2026");
    assert.equal(await page.evaluate(() => document.documentElement.dataset.clicks), "2", "did not claim success on the first click; retried after 'held'");
  } finally {
    await browser.close();
  }
});
