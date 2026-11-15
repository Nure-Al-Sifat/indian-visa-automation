const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",

  // Foreground
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightCyan: "\x1b[96m",
  brightWhite: "\x1b[97m",
};

function getTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${colors.gray}[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}]${colors.reset}`;
}

export const log = {
  colors,

  banner(title = "IVAC VISA BOOKING AUTOMATION", subtitle = "Automatic Flow • Stops Safely at Payment Step") {
    const width = 64;
    const border = "═".repeat(width);
    const center = (str) => {
      const padLen = Math.max(0, Math.floor((width - str.length) / 2));
      return " ".repeat(padLen) + str + " ".repeat(Math.max(0, width - str.length - padLen));
    };

    console.log(`\n${colors.cyan}${colors.bold}╔${border}╗`);
    console.log(`║${colors.reset}${colors.bold}${colors.brightCyan}${center(title)}${colors.reset}${colors.cyan}${colors.bold}║`);
    if (subtitle) {
      console.log(`║${colors.reset}${colors.gray}${center(subtitle)}${colors.reset}${colors.cyan}${colors.bold}║`);
    }
    console.log(`╚${border}╝${colors.reset}\n`);
  },

  info(message) {
    console.log(`${getTimestamp()} ${colors.cyan}ℹ${colors.reset} ${message}`);
  },

  success(message) {
    console.log(`${getTimestamp()} ${colors.green}${colors.bold}✔${colors.reset} ${colors.green}${message}${colors.reset}`);
  },

  step(stepName, detail = "") {
    const detailText = detail ? ` ${colors.gray}•${colors.reset} ${detail}` : "";
    console.log(`${getTimestamp()} ${colors.brightCyan}${colors.bold}➜ [STEP]${colors.reset} ${colors.bold}${stepName}${colors.reset}${detailText}`);
  },

  action(message) {
    console.log(`\n${getTimestamp()} ${colors.brightYellow}${colors.bold}⏳ [ACTION REQUIRED]${colors.reset} ${colors.bold}${message}${colors.reset}`);
  },

  warn(message) {
    console.log(`${getTimestamp()} ${colors.yellow}⚠ ${message}${colors.reset}`);
  },

  error(message) {
    console.log(`${getTimestamp()} ${colors.red}${colors.bold}✖ [ERROR]${colors.reset} ${colors.red}${message}${colors.reset}`);
  },

  item(title, value) {
    console.log(`   ${colors.gray}•${colors.reset} ${colors.bold}${title}:${colors.reset} ${value}`);
  },

  waiting(message) {
    console.log(`${getTimestamp()} ${colors.brightYellow}⏳${colors.reset} ${message}`);
  },

  paymentStop() {
    console.log(`\n${colors.brightYellow}${colors.bold}╔══════════════════════════════════════════════════════════════════╗`);
    console.log(`║                     🛑 PAYMENT STEP REACHED                      ║`);
    console.log(`╠══════════════════════════════════════════════════════════════════╣`);
    console.log(`║  Appointment details submitted successfully.                     ║`);
    console.log(`║  Automation stops here. Complete payment yourself in browser     ║`);
    console.log(`║  to confirm your appointment.                                    ║`);
    console.log(`╚══════════════════════════════════════════════════════════════════╝${colors.reset}\n`);
  },

  divider() {
    console.log(`${colors.gray}──────────────────────────────────────────────────────────────────${colors.reset}`);
  },
};
