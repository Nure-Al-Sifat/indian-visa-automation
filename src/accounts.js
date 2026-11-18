// Accounts for running several bookings side by side.
//
// credentials.json can hold one account (the original format):
//   { "contactNumber": "01XXXXXXXXX", "password": "..." }
// or several, named by key:
//   { "user1": { "contactNumber": "...", "password": "..." },
//     "user2": { "contactNumber": "...", "password": "..." } }
// or as a list:
//   { "users": [ { "name": "user1", "contactNumber": "...", "password": "..." } ] }
//
// Each named account uploads the PDFs in its own folder: doc_file/<name>/.
import { readdir } from "node:fs/promises";
import path from "node:path";

const hasLogin = (value) => Boolean(value) && typeof value === "object" &&
  typeof value.contactNumber === "string" && value.contactNumber.trim() !== "" &&
  typeof value.password === "string" && value.password.trim() !== "";

// Folder- and window-safe version of an account name.
export function safeAccountName(name) {
  return String(name).trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_").replace(/\s+/g, " ") || "account";
}

// Returns { mode: "single" | "multi" | "none", accounts: [{ name, contactNumber, password }], problems: [] }.
export function parseAccounts(json) {
  const problems = [];
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { mode: "none", accounts: [], problems: ["credentials.json must contain a JSON object."] };
  }
  if ("contactNumber" in json || "password" in json) {
    if (!hasLogin(json)) {
      return { mode: "none", accounts: [], problems: ["credentials.json needs non-empty contactNumber and password."] };
    }
    return { mode: "single", accounts: [{ name: null, contactNumber: json.contactNumber.trim(), password: json.password }], problems };
  }

  const entries = Array.isArray(json.users)
    ? json.users.map((user, index) => [user && user.name ? String(user.name) : `user${index + 1}`, user])
    : Object.entries(json);
  const accounts = [];
  const seen = new Set();
  for (const [rawName, value] of entries) {
    const name = String(rawName).trim();
    if (!hasLogin(value)) {
      problems.push(`"${name}" is skipped: it needs non-empty contactNumber and password.`);
      continue;
    }
    if (seen.has(name.toLowerCase())) {
      problems.push(`"${name}" appears more than once; only the first is used.`);
      continue;
    }
    seen.add(name.toLowerCase());
    accounts.push({ name, contactNumber: value.contactNumber.trim(), password: value.password });
  }
  const numbers = new Map();
  for (const account of accounts) {
    if (numbers.has(account.contactNumber)) {
      problems.push(`"${account.name}" uses the same contact number as "${numbers.get(account.contactNumber)}"; one portal account cannot book twice at once.`);
    }
    numbers.set(account.contactNumber, account.name);
  }
  return { mode: accounts.length ? "multi" : "none", accounts, problems };
}

async function listPdfs(folder) {
  try {
    const entries = await readdir(folder, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === ".pdf").map((entry) => entry.name);
  } catch {
    return null;
  }
}

// Pairs each account with doc_file/<name>/. Returns the accounts that are ready
// to run and a note for every account or folder that cannot be used.
export async function planAccountRuns(accounts, docRoot) {
  const ready = [];
  const notes = [];
  for (const account of accounts) {
    const folder = path.join(docRoot, safeAccountName(account.name));
    const pdfs = await listPdfs(folder);
    if (pdfs === null) {
      notes.push(`${account.name}: no folder ${path.join(path.basename(docRoot), safeAccountName(account.name))} - skipped.`);
      continue;
    }
    if (pdfs.length === 0) {
      notes.push(`${account.name}: ${path.join(path.basename(docRoot), safeAccountName(account.name))} has no PDF files - skipped.`);
      continue;
    }
    if (pdfs.length > 4) {
      notes.push(`${account.name}: ${pdfs.length} PDFs, but the portal allows at most 4 per account - skipped.`);
      continue;
    }
    ready.push({ ...account, folder, pdfs });
  }
  // Folders that have documents but no account in credentials.json.
  try {
    const names = new Set(accounts.map((account) => safeAccountName(account.name).toLowerCase()));
    for (const entry of await readdir(docRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !names.has(entry.name.toLowerCase()) && (await listPdfs(path.join(docRoot, entry.name)) || []).length) {
        notes.push(`${entry.name}: has documents but no login in credentials.json - skipped.`);
      }
    }
  } catch {}
  return { ready, notes };
}
