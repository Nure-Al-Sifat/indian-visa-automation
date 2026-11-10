# IVAC appointment helper

A local, user-controlled Patchright helper for the Bangladesh IVAC Appointment Management System. It opens a visible browser, can guide the booking flow after you sign in, and reports recognized booking stages, availability hints, and common errors found in visible page text.

## Setup

1. Install Node.js 20 or newer.
2. Run 
`
npm install
`
.
3. Edit 
`
credentials.json
`
 and enter your contact number and password as JSON strings. Keep this local file private; Git ignores it.
4. Run 
`
npx patchright install chromium
`
.
5. Optionally copy 
`
profile.example.json
`
 to 
`
profile.json
`
 and set values using the exact visible form labels as JSON keys.
6. Run 
`
npm start
`
.

The browser profile is stored in 
`
user-data/
`
; both it and 
`
profile.json
`
 are excluded from Git. The 
`
credentials.json
`
 file stores your contact number and password in plain text and is also excluded from Git. Keep this local file private and delete it yourself when no longer needed.

## Use

- At startup, the helper clicks **Take Your Appointment** automatically. When it can uniquely identify the sign-in controls, it fills `contactNumber` and `password` from `credentials.json` and clicks **Sign In**. Complete Cloudflare/CAPTCHA and OTP directly in the browser. If the fields cannot be identified safely or the credentials are blank, complete sign-in in the browser yourself. Press Enter at the helper prompt after sign-in. The helper never asks you to type credentials or OTP into its console.
- If the IVAC **Important Notice**, **Visa Undertaking** advisory, or **Fraudulent Visa Appointment** advisory appears, the helper closes it using a close control identified within that notice. It does not click the notice's download button.
- After sign-in, the helper closes repeated notices, clicks **Take Your Appointment**, and clicks **Next Step** when the guide screen appears. It asks for one Primary Webfile PDF and up to three Secondary Webfile PDFs, checks that each is a distinct PDF under the portal's 500 KB limit, then uploads them in order. It compares the portal applicant count with the prepared files and asks before clicking **Confirm All Information is Correct**; the portal says the Primary Webfile cannot be deleted or reuploaded after selection. If the upload controls or applicant count cannot be identified safely, it stops for review in the browser.
- After Webfiles are confirmed, the helper selects an eligible centre/date when the portal exposes a unique accessible control, and asks you to choose when there are multiple options. If the portal layout prevents safe identification, it pauses for you to complete that step in the browser.
- Before the date submission, the helper displays the selected centre and date and asks for a final confirmation. It then proceeds to the payment page and stops. You complete payment yourself.
- Press `f` to optionally fill matching, visibly labeled fields and selects from `profile.json`. Confirm before filling, then review every field yourself. Password, OTP, CAPTCHA, card, and payment fields are never autofilled.
- Press `c` to inspect the currently displayed page. The helper reports a best-effort flow step, availability hint, and any recognized error. While it is open, the helper checks visible page text every 15 seconds and reports changes.
- Press `q` to close the browser.

The helper fills the contact number and password from `credentials.json` only when it can identify the sign-in form safely. It never enters OTP, solves CAPTCHA, reloads the page, handles queues, or makes payments. It does not access undocumented APIs. Its text and control matching can miss changed, hidden, or image-only portal elements; verify the live page yourself, especially when the helper asks you to complete a step manually.

The Visa Undertaking advisory says the prescribed form must be completed and uploaded with the online visa application in the NIC Visa Application Portal. Closing that advisory only dismisses the notice; it does not complete or upload the undertaking form.

## Official booking flow

The official IVAC FAQ describes this sequence:

1. Sign in to the Appointment Management System.
2. Select **Take Your Appointment**. If the Webfile guide appears, select **Next Step**.
3. Upload the original, unaltered Primary Webfile. Upload Secondary Webfiles if applicable.
4. Select an eligible IVAC Centre. The portal derives eligible centre options from the Mission in the Primary Webfile.
5. Select an available future appointment date from the calendar. Same-day appointments are not allowed.
6. Proceed to payment and complete it within the booking session.
7. After successful payment and slot confirmation, check the booking details and download the invoice.

The FAQ allows one Primary Applicant plus up to three Secondary Applicants (four Webfiles total). Webfiles must be no more than 30 days old and must correspond to the applicants in the booking. The full process, including payment, has a 15-minute limit. The FAQ says next-two-week slots are released on Thursday or the last working day of the week, subject to availability; booking hours are Sunday-Thursday, 12:00-17:00, and Saturday, 10:00-12:00 Bangladesh time.

## Common problems the helper can recognize

- Account details do not match the Primary Webfile.
- Webfile older than 30 days.
- Incomplete consent.
- CAPTCHA or verification failure.
- Slot unavailable or fully booked.
- Payment failure.
- Booking session expiry or common form/upload validation messages.

These messages are matched from visible page text and may not cover every portal error. If details in the online application are incorrect, the FAQ says to generate a fresh application and Webfile; do not alter the Webfile. Profile editing is restricted after Primary Webfile upload, and DOB cannot be changed after upload. If the 15-minute session expires, the held slot is released and booking must restart. If a slot is not secured, uploaded Webfiles are deleted and must be uploaded again. If payment succeeds but a slot is not confirmed, the FAQ says no invoice is generated and the amount is refunded through the standard reconciliation process.

Successful appointments cannot be cancelled or rescheduled according to the FAQ. Confirm the applicant group, centre, date, and payment details on the portal before you complete the booking.

## Official reference

[IVAC Bangladesh Appointment Management System FAQ](https://www.ivacbd.com/faq/appointment-management-system) (version effective 16 August 2026).

## Validation

Run `npm test` for the local safety and text-detection tests.
