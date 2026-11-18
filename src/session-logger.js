// Deep Persistent Session Logger:
// Writes every account's full activity and API diagnostics to disk under
// logs/<account>/session-<timestamp>.log so logs survive restarts and never
// lose early errors when heavy traffic generates hundreds of lines.
import { appendFile, mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { safeAccountName } from "./accounts.js";

function stampForFile(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function isoTime(ms) {
  return new Date(ms).toISOString();
}

export function createEmptyMetrics() {
  return {
    totalApiCalls: 0,
    http429: 0,
    http5xx: 0,
    http4xx: 0,
    netErrors: 0,
    slowCalls: 0,
    totalLatencyMs: 0,
    avgLatencyMs: 0,
    maxLatencyMs: 0,
    lastApiError: null,
  };
}

export class SessionLogger {
  constructor(logsRoot) {
    this.logsRoot = logsRoot;
    this.sessions = new Map(); // accountName -> { filePath, fileName, startedAt, metrics, queue }
  }

  accountDir(accountName) {
    return path.join(this.logsRoot, safeAccountName(accountName));
  }

  startSession(accountName, meta = {}) {
    const startedAt = Date.now();
    const fileName = `session-${stampForFile(new Date(startedAt))}.log`;
    const dir = this.accountDir(accountName);
    const filePath = path.join(dir, fileName);
    const session = {
      accountName,
      dir,
      filePath,
      fileName,
      startedAt,
      metrics: createEmptyMetrics(),
      queue: Promise.resolve(),
    };
    this.sessions.set(accountName, session);
    const header = [
      "========================================================================",
      `IVAC Session Log | Account: ${accountName} | Started: ${isoTime(startedAt)}`,
      ...(Object.keys(meta).length ? [`Config: ${JSON.stringify(meta)}`] : []),
      "========================================================================",
      "",
    ].join("\n");
    this._enqueue(session, header);
    return session;
  }

  _enqueue(session, text) {
    session.queue = session.queue
      .then(async () => {
        await mkdir(session.dir, { recursive: true });
        await appendFile(session.filePath, text, "utf8");
      })
      .catch(() => {});
  }

  ensureSession(accountName) {
    return this.sessions.get(accountName) || this.startSession(accountName);
  }

  writeLine(accountName, level, text, time = Date.now()) {
    const session = this.ensureSession(accountName);
    const tag = String(level || "info").toUpperCase().padEnd(7, " ");
    this._enqueue(session, `[${isoTime(time)}] [${tag}] ${text}\n`);
  }

  recordApiMetric(accountName, metric) {
    const session = this.ensureSession(accountName);
    const m = session.metrics;
    const status = Number(metric.status || 0);
    const durationMs = Math.max(0, Number(metric.durationMs || 0));

    m.totalApiCalls += 1;
    if (durationMs > 0) {
      m.totalLatencyMs += durationMs;
      m.avgLatencyMs = Math.round(m.totalLatencyMs / m.totalApiCalls);
      if (durationMs > m.maxLatencyMs) m.maxLatencyMs = durationMs;
    }

    if (metric.failed) {
      m.netErrors += 1;
      m.lastApiError = `${metric.method || "GET"} ${metric.path || "/"} (${metric.errorText || "network error"})`;
    } else if (status === 429) {
      m.http429 += 1;
      m.lastApiError = `HTTP 429 on ${metric.method || "GET"} ${metric.path || "/"}`;
    } else if (status >= 500) {
      m.http5xx += 1;
      m.lastApiError = `HTTP ${status} on ${metric.method || "GET"} ${metric.path || "/"}`;
    } else if (status >= 400) {
      m.http4xx += 1;
      m.lastApiError = `HTTP ${status} on ${metric.method || "GET"} ${metric.path || "/"}`;
    }

    if (metric.slow || durationMs >= 4_000) {
      m.slowCalls += 1;
    }

    if (metric.failed || status >= 400 || metric.slow || durationMs >= 4_000) {
      const snippet = metric.errorText ? ` — ${metric.errorText}` : "";
      const summary = metric.failed
        ? `NET_FAIL ${metric.method || "GET"} ${metric.path || "/"} (${durationMs}ms)${snippet}`
        : `HTTP ${status} ${metric.method || "GET"} ${metric.path || "/"} (${durationMs}ms)${snippet}`;
      this.writeLine(accountName, status >= 500 || status === 429 || metric.failed ? "api_err" : "api", summary, metric.time || Date.now());
    }
    return { ...m };
  }

  endSession(accountName, { state = "stopped", exitCode = null, pages = [] } = {}) {
    const session = this.sessions.get(accountName);
    if (!session) return null;
    const endedAt = Date.now();
    const durationSec = Math.max(0, Math.round((endedAt - session.startedAt) / 1000));
    const m = session.metrics;
    const footer = [
      "",
      "------------------------------------------------------------------------",
      `Session Summary | Account: ${accountName} | Ended: ${isoTime(endedAt)}`,
      `Final State: ${state}${exitCode !== null ? ` (exit ${exitCode})` : ""} | Duration: ${durationSec}s`,
      `Pages Visited: ${pages.map((p) => p.label || p.key).join(" -> ") || "none"}`,
      `API Metrics: total=${m.totalApiCalls}, 429=${m.http429}, 5xx=${m.http5xx}, 4xx=${m.http4xx}, netErr=${m.netErrors}, slow(>=4s)=${m.slowCalls}, avgLatency=${m.avgLatencyMs}ms, maxLatency=${m.maxLatencyMs}ms`,
      ...(m.lastApiError ? [`Last API Error: ${m.lastApiError}`] : []),
      "------------------------------------------------------------------------",
      "",
    ].join("\n");
    this._enqueue(session, footer);
    return { durationSec, metrics: { ...m }, fileName: session.fileName };
  }

  getMetrics(accountName) {
    const session = this.sessions.get(accountName);
    if (!session) return { ...createEmptyMetrics(), logFile: null };
    return { ...session.metrics, logFile: session.fileName };
  }

  async flush(accountName) {
    const session = this.sessions.get(accountName);
    if (session) await session.queue;
  }

  async listSessions(accountName) {
    const dir = this.accountDir(accountName);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = entries
      .filter((e) => e.isFile() && /^session-.*\.log$/i.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();
    const list = [];
    for (const file of files.slice(0, 20)) {
      const info = await stat(path.join(dir, file)).catch(() => null);
      list.push({ file, sizeKB: info ? Math.max(1, Math.ceil(info.size / 1024)) : 0, mtime: info ? info.mtimeMs : 0 });
    }
    return list;
  }

  async readLatestLog(accountName) {
    const active = this.sessions.get(accountName);
    if (active) {
      await active.queue;
      const content = await readFile(active.filePath, "utf8").catch(() => null);
      if (content !== null) return { fileName: active.fileName, content };
    }
    const list = await this.listSessions(accountName);
    if (!list.length) return null;
    const latest = list[0].file;
    const content = await readFile(path.join(this.accountDir(accountName), latest), "utf8").catch(() => null);
    if (content === null) return null;
    return { fileName: latest, content };
  }
}
