// Simulations of what happens on the live portal under heavy load, built from
// the cases seen in practice: error pages, OTP sent but the OTP page not
// opening, late OTP, rejected OTP, and an upload the page never shows.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { chromium } from "patchright";
import { runGuidedBookingFlow } from "../src/booking.js";
import { OTP_REJECTED_PATTERN, OTP_SENT_PATTERN, backoffDelay, detectServerTrouble, waitOutServerTrouble } from "../src/resilience.js";

const launch = () => chromium.launch({ channel: "chrome", headless: true });

test("backoff grows and is capped", () => {
  assert.deepEqual([1, 2, 3, 4, 5].map((attempt) => backoffDelay(attempt)), [5_000, 10_000, 20_000, 40_000, 60_000]);
  assert.equal(backoffDelay(9, { base: 60_000, cap: 120_000 }), 120_000);
});

test("recognises the portal's OTP messages", () => {
  assert.equal(OTP_SENT_PATTERN.test("Notification OTP sent successfully!A verification code has been sent to your registered mobile number."), true);
  for (const text of ["Invalid OTP", "OTP has expired", "The verification code is incorrect", "Expired code"]) {
    assert.equal(OTP_REJECTED_PATTERN.test(text), true, text);
  }
  assert.equal(OTP_REJECTED_PATTERN.test("OTP sent successfully"), false);
});

test("detects overloaded, rate-limited, Cloudflare, blank and toast problems, and leaves real portal pages alone", async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const pages = {
      "/502": "<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1><hr>nginx</body></html>",
      "/503": "<h1>Service Temporarily Unavailable</h1><p>The server is temporarily unable to service your request.</p>",
      "/429": "<h1>429 Too Many Requests</h1>",
      "/cf": "<h1>Just a moment...</h1><p>Checking if the site connection is secure</p>",
      "/blank": "<div id=root></div>",
      "/toast": `<h1>Sign In</h1><p>${"Your data is secure with us. ".repeat(40)}</p><section aria-label="Notifications alt+T"><ol><li data-sonner-toast>Too many requests. Please try again after 60 seconds.</li></ol></section>`,
      "/real": await readFile(new URL("./fixtures/time-slot-page.html", import.meta.url), "utf8"),
    };
    await page.route("https://ivac.test/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: pages[new URL(route.request().url()).pathname] }));
    const expectations = { "/502": "server-overloaded", "/503": "server-overloaded", "/429": "rate-limited", "/cf": "cloudflare-check", "/blank": "blank", "/toast": "rate-limited", "/real": null };
    for (const [pathname, expected] of Object.entries(expectations)) {
      await page.goto(`https://ivac.test${pathname}`);
      const trouble = await detectServerTrouble(page);
      assert.equal(trouble ? trouble.key : null, expected, pathname);
    }
  } finally {
    await browser.close();
  }
});

test("rides out an overloaded server: reloads with growing pauses until the page is back", { timeout: 60_000 }, async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    let requests = 0;
    await page.route("https://ivac.test/**", (route) => {
      requests += 1;
      const body = requests <= 2
        ? "<h1>503 Service Temporarily Unavailable</h1>"
        : `<header><button>Logout</button></header><h1>Welcome to Indian Visa Application Center</h1><p>${"Notes. ".repeat(150)}</p>`;
      return route.fulfill({ status: requests <= 2 ? 503 : 200, contentType: "text/html", body });
    });
    await page.goto("https://ivac.test/");
    const recovered = await waitOutServerTrouble(page, { baseDelay: 300 });
    assert.equal(recovered, true);
    assert.equal(requests, 3, "two reloads after the first 503");
  } finally {
    await browser.close();
  }
});

test("OTP sent but the OTP page never opens: opens it directly, then continues after the (late) OTP", { timeout: 120_000 }, async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const visited = [];
    const signinPage = `<!doctype html><body>
      <h2>Sign In</h2>
      <form onsubmit="return false">
        <label>Your Contact Number <input name="phone" placeholder="01......"></label>
        <label>Password <input type="password" name="password"></label>
        <button type="submit" id="go">Sign In Now</button>
      </form>
      <section aria-label="Notifications alt+T"><ol id="toasts"></ol></section>
      <script>
        // Busy portal: the OTP goes out, but the page does not move on.
        document.querySelector('#go').addEventListener('click', () => {
          setTimeout(() => {
            document.querySelector('#toasts').innerHTML = '<li data-sonner-toast>OTP sent successfully! A verification code has been sent to your registered mobile number.</li>';
          }, 500);
        });
      </script></body>`;
    const otpPage = `<!doctype html><body><h2>OTP Verification</h2><p>Verify OTP</p>
      <input autocomplete="one-time-code"><button>Verify OTP</button>
      <script>
        // The user types the late OTP a few seconds later; the portal then logs in.
        setTimeout(() => { location.href = '/'; }, 3000);
      </script></body>`;
    const dashboard = `<!doctype html><body><header><button>Logout</button></header><h1>Welcome</h1><button id="take">Take Your Appointment</button>
      <script>document.querySelector('#take').addEventListener('click', () => { document.body.innerHTML = '<h1>Payment Details</h1><button>Pay Now</button>'; document.documentElement.dataset.done = 'yes'; });</script></body>`;
    await page.route("https://ivac.test/**", (route) => {
      const { pathname } = new URL(route.request().url());
      visited.push(pathname);
      const body = pathname === "/verify-login-phone-otp" ? otpPage : pathname === "/signin" ? signinPage : dashboard;
      return route.fulfill({ status: 200, contentType: "text/html", body });
    });
    await page.goto("https://ivac.test/signin");

    const prompts = { question: () => new Promise(() => {}) };
    await runGuidedBookingFlow(page, prompts, { contactNumber: "01700000000", password: "test-password" });

    assert.ok(visited.includes("/verify-login-phone-otp"), `opened the OTP page directly; visited ${JSON.stringify(visited)}`);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.done), "yes", "continued after the OTP");
  } finally {
    await browser.close();
  }
});

test("an upload the page never shows is confirmed by reloading, not uploaded twice", { timeout: 200_000 }, async () => {
  const browser = await launch();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "ivac-hidden-upload-"));
  const pdf = path.join(tempDir, "01 PRIMARY.pdf");
  try {
    await writeFile(pdf, "%PDF-1.4\nmock\n");
    const page = await browser.newPage();
    let serverCount = 0;
    let uploads = 0;
    const uploadPage = () => `<!doctype html><body>
      <header><button>Logout</button></header>
      <p>Total number of applicants: <span class="text-orange">${serverCount}</span></p>
      ${serverCount ? "<div><span>Primary Applicant</span><br><span>PRIMARY PERSON</span></div>" : ""}
      <div class="border-dashed"><label>${serverCount ? "Upload Other Applicant's Webfile" : "Upload Primary Applicant's Webfile*"}</label></div>
      <input type="file" accept=".pdf,application/pdf" class="hidden">
      <button id="confirm" type="button" ${serverCount ? "" : "disabled"}>Confirm All Information is Correct</button>
      <script>
        // Busy portal: the server stores the file, but the page is not updated.
        document.querySelector('input[type=file]').addEventListener('change', () => { fetch('/api/upload', { method: 'POST' }); });
        document.querySelector('#confirm').addEventListener('click', () => {
          document.body.innerHTML = '<h1>Payment Details</h1><button>Pay Now</button>';
          document.documentElement.dataset.done = 'yes';
        });
      </script></body>`;
    await page.route("https://ivac.test/**", (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/api/upload") {
        uploads += 1;
        serverCount += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      }
      return route.fulfill({ status: 200, contentType: "text/html", body: uploadPage() });
    });
    await page.goto("https://ivac.test/appointment/file-upload");

    const prompts = { async question() { return ""; } };
    await runGuidedBookingFlow(page, prompts, null, { autoUseDocFolder: true, autoConfirmApplicants: true, docFolder: tempDir });

    assert.equal(uploads, 1, "the file was sent once, never again");
    assert.equal(serverCount, 1);
  } finally {
    await browser.close();
    await unlink(pdf).catch(() => {});
    await rmdir(tempDir).catch(() => {});
  }
});
