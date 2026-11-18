// Stands in for src/index.js in the control-panel tests: talks to the panel
// through the same bridge, without opening a browser.
import { log } from "../../src/logger.js";
import { PANEL_MODE, createPanelPrompts, forwardConsoleToPanel, onPanelStop, panelOtp, sendToPanel } from "../../src/panel-bridge.js";

// `node --test` also runs every file under test/; only act when the panel
// server started this file.
if (!PANEL_MODE) process.exit(0);

forwardConsoleToPanel();
onPanelStop(() => {
  console.log("Fake runner stopping.");
  setTimeout(() => process.exit(0), 100);
});
sendToPanel({ type: "state", state: "running" });
log.step("Sign In", "Entered contact number and password");
sendToPanel({ type: "page", key: "otp", label: "OTP verification", path: "/verify-login-phone-otp", tab: 1, turnstile: { present: false }, buttons: ["Verify OTP"], alerts: [] });
panelOtp.request({ path: "/verify-login-phone-otp" });

const timer = setInterval(async () => {
  const code = panelOtp.take();
  if (!code) return;
  clearInterval(timer);
  log.success(`OTP with ${code.length} digits filled in`);
  sendToPanel({ type: "page", key: "mission", label: "Mission & IVAC Center selection", path: "/appointment/mission", tab: 1, turnstile: { present: false }, buttons: [], alerts: [] });
  const answer = await createPanelPrompts().question("Mission number: ");
  log.info(`Mission answer: ${answer}`);
  sendToPanel({ type: "page", key: "payment", label: "Payment", path: "/appointment/payment", tab: 1, turnstile: { present: false }, buttons: ["Pay Now"], alerts: [] });
}, 100);

setInterval(() => {}, 1_000);
