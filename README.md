# IVAC appointment helper

A local, user-controlled Playwright script for the Bangladesh IVAC appointment portal. It opens a visible browser and keeps its session data on this computer so you can complete the website's steps yourself.

## Setup

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Run `npx playwright install chromium`.
4. Optionally copy `profile.example.json` to `profile.json`. Replace the example values with your own values, using the exact visible form labels as JSON keys.
5. Run `npm start`.

The browser profile is stored in `user-data/`; both it and `profile.json` are excluded from Git. They may contain sensitive personal information, so protect this computer and delete those files yourself when no longer needed.

## Use

- Sign in and navigate the portal manually.
- Press `f` to optionally fill matching, non-sensitive, visibly labeled text fields and selects from `profile.json`. Confirm before filling, then review every field yourself.
- Press `c` to check the currently displayed page text for common availability phrases.
- While the script is open, it checks the already-loaded page text every 15 seconds and prints a hint if common availability wording appears. It does not reload, send repeated requests, or access an undocumented API. Phrases may not match the portal's wording; verify availability on the site.
- Press `q` to close the browser.

This helper does not automate booking submission, login credentials, CAPTCHA, OTP, queue steps, file uploads, or payment. It does not bypass access controls or guarantee availability. The portal may change its pages or terms; stop using the helper if the site's rules prohibit it.

## Validation

Run `npm test` for the local safety and text-detection tests.
