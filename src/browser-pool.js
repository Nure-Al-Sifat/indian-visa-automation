// Shared Browser Pool, lightweight asset blocking, and per-account session storage.
// Runs multiple isolated BrowserContexts inside shared Chrome server processes
// to reduce RAM and disk overhead dramatically while keeping every account's
// cookies, localStorage, and navigation state 100% isolated.
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "patchright";
import { safeAccountName } from "./accounts.js";

const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);
const TRACKER_URL_PATTERN = /google-analytics\.com|googletagmanager\.com|doubleclick\.net|clarity\.ms|hotjar\.com|cloudflareinsights\.com|facebook\.net\/.*fbevents/i;
const PROTECTED_ASSET_PATTERN = /challenges\.cloudflare\.com|turnstile|captcha|sslcommerz|bka\.sh|bkash|nagad|amarpay|checkout|payment-?gateway/i;

export const LIGHTWEIGHT_CHROME_ARGS = [
  "--disable-quic",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-sync",
  "--disable-default-apps",
  "--disable-translate",
  "--mute-audio",
];

export function shouldBlockRequest(resourceType, url) {
  if (!url) return false;
  if (TRACKER_URL_PATTERN.test(url)) return true;
  if (PROTECTED_ASSET_PATTERN.test(url)) return false;
  if (BLOCKED_RESOURCE_TYPES.has(resourceType)) return true;
  return false;
}

// Installs lightweight request filtering on a BrowserContext so heavy images,
// fonts, media, and third-party trackers do not consume RAM or bandwidth,
// while preserving all HTML, JS, CSS, API calls, Turnstile, and payment pages.
export async function installLightweightRouting(context, { blockAssets = true } = {}) {
  if (!blockAssets) return { blockedCount: () => 0 };
  let blocked = 0;
  await context.route("**/*", (route) => {
    const request = route.request();
    if (shouldBlockRequest(request.resourceType(), request.url())) {
      blocked += 1;
      return route.abort("blockedbyclient").catch(() => {});
    }
    return route.continue().catch(() => {});
  });
  return { blockedCount: () => blocked };
}

export function sessionFilePath(sessionsRoot, accountName) {
  return path.join(sessionsRoot, `${safeAccountName(accountName)}.json`);
}

export async function loadExistingSessionPath(sessionsRoot, accountName) {
  const filePath = sessionFilePath(sessionsRoot, accountName);
  try {
    await access(filePath);
    return filePath;
  } catch {
    return undefined;
  }
}

export async function saveContextSession(context, sessionsRoot, accountName) {
  if (!accountName) return false;
  try {
    await mkdir(sessionsRoot, { recursive: true });
    await context.storageState({ path: sessionFilePath(sessionsRoot, accountName) });
    return true;
  } catch {
    return false;
  }
}

// Manages a pool of shared Chrome browser servers. Each pooled Chrome hosts up
// to `maxContextsPerBrowser` isolated accounts before a new Chrome is spawned.
export class BrowserPool {
  constructor({
    maxContextsPerBrowser = 10,
    idleCloseMs = 15_000,
    headless = false,
    launcher = null,
    onChange = null,
  } = {}) {
    this.maxContextsPerBrowser = Math.max(1, Number(maxContextsPerBrowser) || 10);
    this.idleCloseMs = Math.max(0, Number(idleCloseMs) || 0);
    this.headless = Boolean(headless);
    this.launcher = launcher;
    this.onChange = onChange;
    this.slots = []; // { id, server, wsEndpoint, accounts: Set<string>, idleTimer, closing }
    this.nextId = 1;
    this.pendingLaunch = null;
  }

  configure({ maxContextsPerBrowser, headless } = {}) {
    if (maxContextsPerBrowser !== undefined) {
      this.maxContextsPerBrowser = Math.max(1, Math.min(25, Number(maxContextsPerBrowser) || 10));
    }
    if (headless !== undefined) {
      this.headless = Boolean(headless);
    }
    this._notify();
  }

  _notify() {
    try {
      this.onChange?.(this.stats());
    } catch {}
  }

  async _launchServer() {
    if (this.launcher) return this.launcher({ headless: this.headless });
    return chromium.launchServer({
      channel: "chrome",
      headless: this.headless,
      args: [
        ...LIGHTWEIGHT_CHROME_ARGS,
        ...(this.headless ? ["--window-size=1280,800"] : []),
      ],
    });
  }

  async acquire(accountName) {
    // Reuse existing assignment if account already mapped
    for (const slot of this.slots) {
      if (!slot.closing && slot.accounts.has(accountName)) {
        if (slot.idleTimer) {
          clearTimeout(slot.idleTimer);
          slot.idleTimer = null;
        }
        return { wsEndpoint: slot.wsEndpoint, browserId: slot.id };
      }
    }

    // Find an active slot with room
    let target = this.slots.find(
      (slot) => !slot.closing && slot.accounts.size < this.maxContextsPerBrowser,
    );

    if (!target) {
      // Serialize concurrent browser launches so two accounts starting at the
      // exact same millisecond share the newly launched browser instead of
      // accidentally spawning two browsers.
      if (this.pendingLaunch) {
        await this.pendingLaunch;
        return this.acquire(accountName);
      }
      let resolveLaunch;
      this.pendingLaunch = new Promise((resolve) => { resolveLaunch = resolve; });
      try {
        const server = await this._launchServer();
        const id = this.nextId++;
        target = {
          id,
          server,
          wsEndpoint: server.wsEndpoint(),
          accounts: new Set(),
          idleTimer: null,
          closing: false,
        };
        if (typeof server.on === "function") {
          server.on("close", () => {
            this.slots = this.slots.filter((s) => s !== target);
            this._notify();
          });
        }
        this.slots.push(target);
      } finally {
        this.pendingLaunch = null;
        resolveLaunch();
      }
    }

    if (target.idleTimer) {
      clearTimeout(target.idleTimer);
      target.idleTimer = null;
    }
    target.accounts.add(accountName);
    this._notify();
    return { wsEndpoint: target.wsEndpoint, browserId: target.id };
  }

  release(accountName) {
    let released = false;
    for (const slot of this.slots) {
      if (slot.accounts.delete(accountName)) {
        released = true;
        if (slot.accounts.size === 0 && !slot.closing) {
          if (this.idleCloseMs === 0) {
            void this._closeSlot(slot);
          } else {
            slot.idleTimer = setTimeout(() => {
              slot.idleTimer = null;
              if (slot.accounts.size === 0) void this._closeSlot(slot);
            }, this.idleCloseMs);
          }
        }
      }
    }
    if (released) this._notify();
    return released;
  }

  async _closeSlot(slot) {
    if (slot.closing) return;
    slot.closing = true;
    if (slot.idleTimer) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }
    this.slots = this.slots.filter((s) => s !== slot);
    try {
      await slot.server.close();
    } catch {}
    this._notify();
  }

  async closeAll() {
    const current = [...this.slots];
    await Promise.all(current.map((slot) => this._closeSlot(slot)));
  }

  stats() {
    const activeSlots = this.slots.filter((s) => !s.closing);
    const activeContexts = activeSlots.reduce((sum, s) => sum + s.accounts.size, 0);
    return {
      browsers: activeSlots.length,
      activeContexts,
      maxContextsPerBrowser: this.maxContextsPerBrowser,
      capacity: activeSlots.length * this.maxContextsPerBrowser,
    };
  }
}
