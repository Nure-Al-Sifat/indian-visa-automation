import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAccounts, planAccountRuns, safeAccountName } from "../src/accounts.js";

test("reads the original single-account credentials", () => {
  const result = parseAccounts({ contactNumber: " 01700000001 ", password: "pw" });
  assert.equal(result.mode, "single");
  assert.deepEqual(result.accounts, [{ name: null, contactNumber: "01700000001", password: "pw" }]);
});

test("reads several accounts by name (user1, user2, ...) and as a users list", () => {
  const named = parseAccounts({
    user1: { contactNumber: "01700000001", password: "a" },
    user2: { contactNumber: "01700000002", password: "b" },
    user3: { contactNumber: "", password: "c" },
  });
  assert.equal(named.mode, "multi");
  assert.deepEqual(named.accounts.map((account) => account.name), ["user1", "user2"]);
  assert.match(named.problems.join(" "), /user3.*skipped/);

  const listed = parseAccounts({ users: [{ name: "user1", contactNumber: "01700000001", password: "a" }, { contactNumber: "01700000002", password: "b" }] });
  assert.deepEqual(listed.accounts.map((account) => account.name), ["user1", "user2"]);
});

test("warns when two accounts share a contact number", () => {
  const result = parseAccounts({ user1: { contactNumber: "01700000001", password: "a" }, user2: { contactNumber: "01700000001", password: "b" } });
  assert.match(result.problems.join(" "), /same contact number/);
});

test("pairs each account with doc_file/<name> and explains every skipped one", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ivac-accounts-"));
  try {
    const pdf = "%PDF-1.4\n";
    await mkdir(path.join(root, "user1"));
    for (const name of ["01 A.pdf", "02 B.pdf", "03 C.pdf"]) await writeFile(path.join(root, "user1", name), pdf);
    await mkdir(path.join(root, "user3"));
    await mkdir(path.join(root, "user4"));
    for (const name of ["01.pdf", "02.pdf", "03.pdf", "04.pdf", "05.pdf"]) await writeFile(path.join(root, "user4", name), pdf);
    await mkdir(path.join(root, "user9"));
    await writeFile(path.join(root, "user9", "01.pdf"), pdf);

    const accounts = ["user1", "user2", "user3", "user4"].map((name, index) => ({ name, contactNumber: `0170000000${index}`, password: "x" }));
    const { ready, notes } = await planAccountRuns(accounts, root);

    assert.deepEqual(ready.map((account) => [account.name, account.pdfs.length]), [["user1", 3]]);
    const text = notes.join("\n");
    assert.match(text, /user2: no folder/);
    assert.match(text, /user3: .*no PDF/);
    assert.match(text, /user4: 5 PDFs.*at most 4/);
    assert.match(text, /user9: has documents but no login/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("account names are safe for folders and window titles", () => {
  assert.equal(safeAccountName("user 1"), "user 1");
  assert.equal(safeAccountName('a/b:c*"d'), "a_b_c_d");
});

test("the launcher opens one window per ready account, a stagger apart (dry run)", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ivac-launch-"));
  try {
    const docs = path.join(root, "doc_file");
    for (const user of ["user1", "user2"]) {
      await mkdir(path.join(docs, user), { recursive: true });
      await writeFile(path.join(docs, user, "01.pdf"), "%PDF-1.4\n");
    }
    const credentials = path.join(root, "credentials.json");
    await writeFile(credentials, JSON.stringify({
      user1: { contactNumber: "01700000011", password: "a" },
      user2: { contactNumber: "01700000022", password: "b" },
      user3: { contactNumber: "01700000033", password: "c" },
    }));
    const indexPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
    const output = await new Promise((resolve, reject) => {
      execFile(process.execPath, [indexPath], {
        env: { ...process.env, IVAC_CREDENTIALS: credentials, IVAC_DOC_ROOT: docs, IVAC_LAUNCH_DRY_RUN: "1", IVAC_STAGGER_SECONDS: "20" },
      }, (error, stdout, stderr) => (error ? reject(error) : resolve(stdout + stderr)));
    });
    const plain = output.replace(/\x1b\[[0-9;]*m/g, "");
    assert.match(plain, /2 account\(s\) ready/);
    assert.match(plain, /user1:.*number ending 11.*starts now/);
    assert.match(plain, /user2:.*number ending 22.*starts after 20s/);
    assert.match(plain, /user3: no folder/);
    assert.equal((plain.match(/\[dry run\] would open a window/g) || []).length, 2);
    assert.doesNotMatch(plain, /0170000001|0170000002/, "full numbers are never printed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
