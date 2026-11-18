// Adaptive Circuit Breaker for heavy-traffic portal protection.
// Monitors global HTTP 429, 5xx, network failure, and slow-API signals across
// all running accounts. Automatically slows stagger in degraded conditions and
// pauses new launches during severe rate-limiting or outages without killing
// accounts that are already past sign-in.

export class CircuitBreaker {
  constructor({
    enabled = true,
    windowMs = 60_000,
    baseCooldownMs = 45_000,
    maxCooldownMs = 120_000,
    onChange = null,
    now = () => Date.now(),
  } = {}) {
    this.enabled = Boolean(enabled);
    this.windowMs = windowMs;
    this.baseCooldownMs = baseCooldownMs;
    this.maxCooldownMs = maxCooldownMs;
    this.onChange = onChange;
    this.now = now;

    this.events = []; // { time, type, account, detail }
    this.state = "healthy"; // "healthy" | "degraded" | "open"
    this.manualPause = false;
    this.reason = "";
    this.cooldownUntil = null;
    this.tripCount = 0;
    this.cooldownTimer = null;
  }

  configure({ enabled } = {}) {
    if (enabled !== undefined) {
      this.enabled = Boolean(enabled);
      if (!this.enabled && !this.manualPause) {
        this._clearTimer();
        this.state = "healthy";
        this.cooldownUntil = null;
        this.reason = "";
      } else {
        this.evaluate();
      }
      this._notify();
    }
  }

  _clearTimer() {
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
  }

  _prune() {
    const cutoff = this.now() - this.windowMs;
    while (this.events.length && this.events[0].time < cutoff) {
      this.events.shift();
    }
  }

  _counts() {
    this._prune();
    let count429 = 0;
    let count5xx = 0;
    let countNet = 0;
    let countSlow = 0;
    let countOk = 0;
    for (const e of this.events) {
      if (e.type === "429") count429 += 1;
      else if (e.type === "5xx") count5xx += 1;
      else if (e.type === "net") countNet += 1;
      else if (e.type === "slow") countSlow += 1;
      else if (e.type === "ok") countOk += 1;
    }
    return { count429, count5xx, countNet, countSlow, countOk };
  }

  record({ status = 0, failed = false, slow = false, durationMs = 0, account = "", detail = "" } = {}) {
    const time = this.now();
    let type = "ok";
    if (failed) type = "net";
    else if (status === 429) type = "429";
    else if (status >= 500) type = "5xx";
    else if (slow || durationMs >= 6_000) type = "slow";
    else if (status >= 200 && status < 400) type = "ok";
    else return this.status();

    this.events.push({ time, type, account, detail });
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
    return this.evaluate();
  }

  evaluate() {
    const prevState = this.state;
    const prevReason = this.reason;
    const now = this.now();

    if (this.manualPause) {
      this.state = "open";
      this._notifyIfChanged(prevState, prevReason);
      return this.status();
    }

    if (!this.enabled) {
      this.state = "healthy";
      this.cooldownUntil = null;
      this.reason = "";
      this._notifyIfChanged(prevState, prevReason);
      return this.status();
    }

    // If currently in open cooldown and cooldown hasn't expired, stay open
    if (this.state === "open" && this.cooldownUntil && now < this.cooldownUntil) {
      return this.status();
    }

    // Cooldown just finished -> transition to degraded recovery state
    if (this.state === "open" && this.cooldownUntil && now >= this.cooldownUntil) {
      this._clearTimer();
      this.cooldownUntil = null;
      this.state = "degraded";
      this.reason = "Recovering after cooldown (2x stagger)";
      // Clear old severe events so it doesn't immediately re-trip before fresh traffic
      this.events = this.events.filter((e) => e.type === "ok");
      this._notify();
      return this.status();
    }

    const c = this._counts();
    const severeErrors = c.count5xx + c.countNet;

    if (c.count429 >= 2 || severeErrors >= 4) {
      this.tripCount += 1;
      const cooldownMs = Math.min(this.maxCooldownMs, this.baseCooldownMs * (2 ** Math.min(2, this.tripCount - 1)));
      this.state = "open";
      this.cooldownUntil = now + cooldownMs;
      this.reason = c.count429 >= 2
        ? `Rate limit spike (${c.count429}x HTTP 429 in 60s) — pausing new launches for ${Math.round(cooldownMs / 1000)}s`
        : `Portal overload (${c.count5xx}x 5xx, ${c.countNet}x net errors in 60s) — pausing new launches for ${Math.round(cooldownMs / 1000)}s`;
      this._clearTimer();
      this.cooldownTimer = setTimeout(() => {
        this.cooldownTimer = null;
        this.evaluate();
      }, cooldownMs + 50);
      if (typeof this.cooldownTimer.unref === "function") this.cooldownTimer.unref();
    } else if (c.count429 >= 1 || severeErrors >= 2 || c.countSlow >= 3) {
      this.state = "degraded";
      if (c.count429 >= 1) this.reason = "Rate limit detected (HTTP 429) — slowing launches (2x stagger)";
      else if (severeErrors >= 2) this.reason = `Portal unstable (${severeErrors} server/network errors) — slowing launches (2x stagger)`;
      else this.reason = `Slow portal responses (${c.countSlow} slow API calls) — slowing launches (2x stagger)`;
    } else {
      this.state = "healthy";
      this.reason = "";
      if (c.countOk >= 3) this.tripCount = 0;
    }

    this._notifyIfChanged(prevState, prevReason);
    return this.status();
  }

  pause(reason = "Manually paused by operator") {
    this._clearTimer();
    this.manualPause = true;
    this.state = "open";
    this.cooldownUntil = null;
    this.reason = reason;
    this._notify();
    return this.status();
  }

  reset() {
    this._clearTimer();
    this.manualPause = false;
    this.state = "healthy";
    this.cooldownUntil = null;
    this.reason = "";
    this.tripCount = 0;
    this.events = [];
    this._notify();
    return this.status();
  }

  canLaunch() {
    this.evaluate();
    return this.state !== "open";
  }

  effectiveStaggerMs(baseStaggerMs) {
    this.evaluate();
    if (!this.enabled) return Math.max(0, baseStaggerMs);
    if (this.state === "degraded") {
      return baseStaggerMs > 0 ? Math.min(120_000, baseStaggerMs * 2) : 5_000;
    }
    return Math.max(0, baseStaggerMs);
  }

  status() {
    const recent = this._counts();
    const cooldownRemainingSec = this.cooldownUntil
      ? Math.max(0, Math.ceil((this.cooldownUntil - this.now()) / 1000))
      : 0;
    return {
      enabled: this.enabled,
      state: this.state,
      manualPause: this.manualPause,
      reason: this.reason,
      cooldownUntil: this.cooldownUntil,
      cooldownRemainingSec,
      tripCount: this.tripCount,
      staggerMultiplier: this.state === "degraded" ? 2 : 1,
      recent,
    };
  }

  _notifyIfChanged(prevState, prevReason) {
    if (prevState !== this.state || prevReason !== this.reason) {
      this._notify();
    }
  }

  _notify() {
    try {
      this.onChange?.(this.status());
    } catch {}
  }

  destroy() {
    this._clearTimer();
  }
}
