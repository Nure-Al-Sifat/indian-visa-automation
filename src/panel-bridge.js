// Link between one account's booking runner and the control panel server.
// The server starts each account as a child process with an IPC channel; this
// module sends status (log lines, steps, the page that is open, questions,
// OTP requests) and receives OTPs, answers and commands (resume, reload, stop).
// Outside the panel (plain `npm run cli`) everything here is inactive.

export const PANEL_MODE = typeof process.send === "function" && process.env.IVAC_DASHBOARD === "1";

const stripAnsi = (text) => String(text).replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\][^\x07]*\x07/g, "");

export function sendToPanel(event) {
  if (!PANEL_MODE) return;
  try {
    process.send({ ...event, time: Date.now() });
  } catch {}
}

// Every console line also goes to the panel, with a level taken from the
// logger's markers (⚠ warning, ✖ error, ✔ success, ➜ [STEP], ⏳ action).
export function forwardConsoleToPanel() {
  if (!PANEL_MODE) return;
  for (const method of ["log", "info", "warn", "error"]) {
    const original = console[method].bind(console);
    console[method] = (...args) => {
      original(...args);
      const text = stripAnsi(args.map((arg) => (typeof arg === "string" ? arg : arg instanceof Error ? arg.message : JSON.stringify(arg))).join(" ")).trim();
      if (!text) return;
      for (const line of text.split(/\r?\n/)) {
        const clean = line.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "").trim();
        if (!clean || /^[═║╔╗╚╝╠╣─]+$/.test(clean)) continue;
        let level = method === "error" ? "error" : method === "warn" ? "warn" : "info";
        if (/✖|\[ERROR\]/.test(clean)) level = "error";
        else if (/⚠/.test(clean)) level = "warn";
        else if (/✔/.test(clean)) level = "success";
        else if (/➜ \[STEP\]/.test(clean)) level = "step";
        else if (/⏳|\[ACTION REQUIRED\]/.test(clean)) level = "action";
        else if (/^📝 Journal/.test(clean)) level = "journal";
        const step = clean.match(/➜ \[STEP\]\s*(.+?)(?:\s*•\s*(.*))?$/);
        sendToPanel({ type: "log", level, text: clean, ...(step ? { step: step[1].trim(), detail: (step[2] || "").trim() } : {}) });
      }
    };
  }
}

// --- Incoming messages -------------------------------------------------------

let nextQuestionId = 1;
const pendingQuestions = new Map();
const commandWaiters = [];
const commandQueue = [];
const stopListeners = [];
let otpCode = null;

if (PANEL_MODE) {
  process.on("message", (message) => {
    if (!message || typeof message !== "object") return;
    if (message.type === "answer" && pendingQuestions.has(message.id)) {
      const { resolve } = pendingQuestions.get(message.id);
      pendingQuestions.delete(message.id);
      resolve(String(message.text ?? ""));
      return;
    }
    if (message.type === "otp") {
      const digits = String(message.code ?? "").replace(/\D/g, "");
      if (digits.length >= 4 && digits.length <= 8) {
        otpCode = digits;
        sendToPanel({ type: "otp-received" });
      }
      return;
    }
    if (message.type === "stop") {
      for (const listener of stopListeners) listener();
    }
    if (["resume", "reload", "stop"].includes(message.type)) {
      const waiter = commandWaiters.shift();
      if (waiter) waiter(message.type);
      else commandQueue.push(message.type);
    }
  });
}

// The OTP typed in the panel, handed over once.
export const panelOtp = {
  take() {
    const code = otpCode;
    otpCode = null;
    return code;
  },
  request(details = {}) {
    sendToPanel({ type: "need-otp", ...details });
  },
};

export function onPanelStop(listener) {
  stopListeners.push(listener);
}

// Waits for the next command from the panel ("resume", "reload" or "stop").
export function nextPanelCommand(signal) {
  if (commandQueue.length) return Promise.resolve(commandQueue.shift());
  return new Promise((resolve, reject) => {
    const waiter = (command) => resolve(command);
    commandWaiters.push(waiter);
    signal?.addEventListener("abort", () => {
      const index = commandWaiters.indexOf(waiter);
      if (index !== -1) commandWaiters.splice(index, 1);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  });
}

// A readline-like `prompts` object whose questions are answered in the panel.
export function createPanelPrompts() {
  return {
    closed: false,
    question(text, { signal } = {}) {
      const id = nextQuestionId++;
      sendToPanel({ type: "question", id, text: stripAnsi(text).trim() });
      return new Promise((resolve, reject) => {
        pendingQuestions.set(id, { resolve });
        signal?.addEventListener("abort", () => {
          if (pendingQuestions.delete(id)) {
            sendToPanel({ type: "question-cancelled", id });
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          }
        }, { once: true });
      });
    },
    close() {
      this.closed = true;
    },
  };
}
