import { before, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, kitRoot, lines } from "./fixtures/film.ts";
import { boardDir } from "./fixtures/board.ts";
import { keyOf } from "./fixtures/requests.ts";

// film:ledger appends one row per call to ledger.jsonl (asked, polled, delivered, declined,
// failed) and never rewrites it; --check prints a reference's state. A decline closes the
// reference on every provider.

let dir = "";
let key = "";
let motionKey = "";
before(() => {
  dir = boardDir();
  cpSync(join(kitRoot, "tests", "fixtures", "requests", "M01.json"), join(dir, "clips", "M01.json"));
  const w = film("request", dir, ["--clip", "clips/W01.json", "--provider", "openrouter", "--ledger", "proj/ledger.jsonl", "--out", "req", "--start-artifact", "a1", "--window-artifact", "a2"]);
  assert.equal(w.status, 0, w.stdout + w.stderr);
  key = JSON.parse(readFileSync(join(dir, "req", "W01.request.json"), "utf8")).idempotency_key;
  const m = film("request", dir, ["--clip", "clips/M01.json", "--provider", "higgsfield", "--ledger", "proj/ledger.jsonl", "--out", "req", "--start-artifact", "a1"]);
  assert.equal(m.status, 0, m.stdout + m.stderr);
  motionKey = JSON.parse(readFileSync(join(dir, "req", "M01.request.json"), "utf8")).idempotency_key;
  writeFileSync(join(dir, "take.mp4"), "not really a video");
});

const rowsOf = (file: string) => readFileSync(join(dir, file), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
const L = (...action: string[]) => ["--ledger", "proj/ledger.jsonl", "--out", "proj", ...action];

test("asked, polled, delivered: one row each, appended, the asked row's facts carried", () => {
  const asked = film("ledger", dir, L("--asked", "req/W01.request.json"));
  assert.equal(asked.status, 0, asked.stdout + asked.stderr);
  assert.equal(asked.stderr, "");
  assert.deepEqual(lines(asked.stdout), ['ledger: asked "W01" attempt 1 on openrouter, estimate $1.16']);
  const before = readFileSync(join(dir, "proj", "ledger.jsonl"), "utf8");

  const polled = film("ledger", dir, L("--polled", key, "--figures", '{"status": "in_progress"}'));
  assert.equal(polled.status, 0, polled.stdout + polled.stderr);
  assert.deepEqual(lines(polled.stdout), ['ledger: polled "W01" attempt 1 on openrouter']);
  const delivered = film("ledger", dir, L("--delivered", key, "--file", "take.mp4", "--figures", '{"usage": {"cost": 1.155}}'));
  assert.equal(delivered.status, 0, delivered.stdout + delivered.stderr);
  assert.deepEqual(lines(delivered.stdout), ['ledger: delivered "W01" attempt 1 on openrouter: "take.mp4"']);

  // Appended, never rewritten: the earlier text is a prefix of the file.
  const text = readFileSync(join(dir, "proj", "ledger.jsonl"), "utf8");
  assert.ok(text.startsWith(before));
  const rows = rowsOf("proj/ledger.jsonl");
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row), ["ts", "kind", "key", "reference", "attempt", "provider", "estimate", "figures", "file", "reason"]);
    assert.ok(!Number.isNaN(Date.parse(row.ts)));
    assert.equal(row.key, key);
    assert.equal(row.reference, "W01");
    assert.equal(row.attempt, 1);
    assert.equal(row.provider, "openrouter");
    assert.equal(row.estimate, 1.16);
  }
  assert.deepEqual(rows.map((r) => r.kind), ["asked", "polled", "delivered"]);
  assert.deepEqual(rows[1].figures, { status: "in_progress" });
  assert.deepEqual(rows[2].figures, { usage: { cost: 1.155 } });
  assert.equal(rows[2].file, "take.mp4");
  assert.equal(rows[0].figures, null);

  const report = JSON.parse(readFileSync(join(dir, "proj", "ledger-report.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.deepEqual(report.inputs, { ledger: join(dir, "proj", "ledger.jsonl"), action: "delivered", key, meta: null, file: "take.mp4", figures: { usage: { cost: 1.155 } }, reason: null });
  assert.deepEqual(report.outputs, { ledger: "ledger.jsonl", report: "ledger-report.json" });
  assert.deepEqual(report.row, rows[2]);
  assert.equal(report.state.attempts, 1);
  assert.equal(report.state.last_kind, "delivered");

  // A key delivered once cannot be delivered again.
  const again = film("ledger", dir, L("--delivered", key, "--file", "take.mp4"));
  assert.equal(again.status, 2);
  assert.deepEqual(lines(again.stdout), [`--delivered: key "${key}" is already delivered`]);
  assert.equal(rowsOf("proj/ledger.jsonl").length, 3);
});

test("--check prints the reference's state; a decline closes it on every provider", () => {
  const check = film("ledger", dir, L("--check", "W01"));
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.deepEqual(lines(check.stdout), ['ledger: "W01": 1 attempt, last delivered, declined on none, $1.16 asked']);
  const state = JSON.parse(readFileSync(join(dir, "proj", "ledger-report.json"), "utf8")).state;
  assert.deepEqual(state, {
    reference: "W01", attempts: 1, last_kind: "delivered", last_key: key, declined_on: [],
    delivered: [{ key, attempt: 1, provider: "openrouter", file: "take.mp4" }], estimate_total: 1.16,
  });

  assert.equal(film("ledger", dir, L("--asked", "req/M01.request.json")).status, 0);
  const declined = film("ledger", dir, L("--declined", motionKey, "--reason", "face filter", "--figures", '{"error": "declined"}'));
  assert.equal(declined.status, 0, declined.stdout + declined.stderr);
  assert.deepEqual(lines(declined.stdout), ['ledger: declined "M01" attempt 1 on higgsfield: "M01" is closed on every provider']);
  const last = rowsOf("proj/ledger.jsonl").at(-1);
  assert.equal(last.kind, "declined");
  assert.equal(last.reason, "face filter");
  const closed = film("ledger", dir, L("--check", "M01"));
  assert.deepEqual(lines(closed.stdout), ['ledger: "M01": 1 attempt, last declined, declined on higgsfield, $2.80 asked']);

  // film:request reads it: M01 is refused on the other provider too.
  const request = film("request", dir, ["--clip", "clips/M01.json", "--provider", "openrouter", "--ledger", "proj/ledger.jsonl", "--out", "again", "--start-artifact", "a1"]);
  assert.equal(request.status, 2, request.stdout + request.stderr);
  assert.deepEqual(lines(request.stdout), ['"M01" was declined on higgsfield: no request for it on any provider']);

  // A reference never asked: no attempt.
  const none = film("ledger", dir, L("--check", "W77"));
  assert.equal(none.status, 0);
  assert.deepEqual(lines(none.stdout), ['ledger: "W77": 0 attempts, last none, declined on none, $0.00 asked']);
});

test("refusals: one line each, exit 2, the ledger left as it was", () => {
  writeFileSync(join(dir, "notreq.json"), '{"secret": "X"}');
  writeFileSync(join(dir, "afile"), "");
  const ledger = () => readFileSync(join(dir, "proj", "ledger.jsonl"), "utf8");
  const before = ledger();
  const unknown = "0".repeat(64);
  const cases: [string[], string][] = [
    [["--ledger", "proj/ledger.jsonl", "--out", "proj"], "film:ledger: --ledger, --out and one of --asked, --polled, --delivered, --declined, --failed or --check are required"],
    [L("--polled", key, "--failed", key), "film:ledger: give one of --asked, --polled, --delivered, --declined, --failed or --check"],
    [L("--polled", unknown), `--polled: key "${unknown}" is not in the ledger`],
    [L("--failed", unknown, "--reason", "x"), `--failed: key "${unknown}" is not in the ledger`],
    [L("--delivered", key), "--delivered needs --file <path>"],
    [L("--delivered", motionKey, "--file", "nope.mp4"), "--file cannot be read"],
    [L("--polled", key, "--file", "take.mp4"), "--file goes with --delivered only"],
    [L("--polled", key, "--figures", "[1]"), "--figures is not a JSON object"],
    [L("--polled", key, "--figures", "{oops"), "--figures is not a JSON object"],
    [L("--asked", "req/W01.request.json"), `--asked: key "${key}" is already in the ledger`],
    [L("--asked", "notreq.json"), "--asked is not a request file"],
    [L("--asked", "missing.json"), "--asked cannot be read"],
    [L("--asked", "req/W01.request.json", "--figures", "{}"), "--figures and --reason go with the rows after asked"],
    [L("--asked", "req/W01.request.json", "--meta", "nope.json"), "--meta cannot be read"],
    [L("--asked", "req/W01.request.json", "--meta", "notreq.json"), "--meta is not a request meta file"],
    [L("--polled", key, "--meta", "req/W01.request.meta.json"), "--meta goes with --asked only"],
    // A declined reference is terminal: no row but its own after the decline.
    [L("--polled", motionKey), '--polled: "M01" was declined on higgsfield: the reference is closed'],
    [L("--delivered", motionKey, "--file", "take.mp4"), '--delivered: "M01" was declined on higgsfield: the reference is closed'],
    [L("--failed", motionKey, "--reason", "late"), '--failed: "M01" was declined on higgsfield: the reference is closed'],
    // A delivered key cannot then be declined.
    [L("--declined", key, "--reason", "face filter"), `--declined: key "${key}" is already delivered`],
    [["--ledger", "elsewhere/ledger.jsonl", "--out", "proj", "--polled", key], "--ledger must be inside --out (the ledger is appended to)"],
    [["--ledger", "afile/ledger.jsonl", "--out", "afile", "--polled", key], "--out is not a folder"],
  ];
  for (const [flags, want] of cases) {
    const result = film("ledger", dir, flags);
    assert.equal(result.status, 2, `${flags.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(lines(result.stdout), [want], flags.join(" "));
    assert.equal(ledger(), before, flags.join(" "));
  }
  assert.equal(existsSync(join(dir, "elsewhere")), false);

  // A stale request: two requests shaped for attempt 1, on two providers; once one is asked,
  // the other's attempt is taken.
  const shape = (provider: string, out: string) =>
    film("request", dir, ["--clip", "clips/W01.json", "--provider", provider, "--ledger", "fresh/ledger.jsonl", "--out", out, "--start-artifact", "a1", "--window-artifact", "a2"]);
  assert.equal(shape("openrouter", "s1").status, 0);
  assert.equal(shape("higgsfield", "s2").status, 0);
  const F = (...action: string[]) => ["--ledger", "fresh/ledger.jsonl", "--out", "fresh", ...action];
  assert.equal(film("ledger", dir, F("--asked", "s1/W01.request.json")).status, 0);
  const old = film("ledger", dir, F("--asked", "s2/W01.request.json"));
  assert.equal(old.status, 2);
  assert.deepEqual(lines(old.stdout), ['--asked: "W01" attempt 1 is stale, the ledger holds 1 asked: shape the request again']);

  // The key is recomputed from the request and the meta's attempt: a meta that does not
  // match its request is refused.
  mkdirSync(join(dir, "s3"));
  cpSync(join(dir, "s2", "W01.request.json"), join(dir, "s3", "W01.request.json"));
  const meta = JSON.parse(readFileSync(join(dir, "s2", "W01.request.meta.json"), "utf8"));
  meta.attempt = 2;
  writeFileSync(join(dir, "s3", "W01.request.meta.json"), JSON.stringify(meta));
  const mismatch = film("ledger", dir, F("--asked", "s3/W01.request.json"));
  assert.equal(mismatch.status, 2);
  assert.deepEqual(lines(mismatch.stdout), ['--asked: the idempotency_key is not the key of the body, provider, model and attempt 2']);

  // A request for a declined reference is refused too, its key right for attempt 2.
  const request = JSON.parse(readFileSync(join(dir, "req", "M01.request.json"), "utf8"));
  const mMeta = JSON.parse(readFileSync(join(dir, "req", "M01.request.meta.json"), "utf8"));
  mMeta.attempt = 2;
  request.idempotency_key = mMeta.idempotency_key = keyOf("higgsfield", "bytedance/seedance-2.5", request.body, 2);
  writeFileSync(join(dir, "s3", "M01.request.json"), JSON.stringify(request));
  writeFileSync(join(dir, "s3", "M01.request.meta.json"), JSON.stringify(mMeta));
  const closed = film("ledger", dir, L("--asked", "s3/M01.request.json"));
  assert.equal(closed.status, 2);
  assert.deepEqual(lines(closed.stdout), ['--asked: "M01" was declined on higgsfield: no request for it on any provider']);

  // A malformed ledger is refused before anything is appended.
  mkdirSync(join(dir, "broken"));
  writeFileSync(join(dir, "broken", "ledger.jsonl"), "{}\n");
  const broken = film("ledger", dir, ["--ledger", "broken/ledger.jsonl", "--out", "broken", "--check", "W01"]);
  assert.equal(broken.status, 2);
  assert.deepEqual(lines(broken.stdout), ["--ledger line 1 is not a ledger row"]);
  assert.equal(readFileSync(join(dir, "broken", "ledger.jsonl"), "utf8"), "{}\n");
});

test("the ledger is never written through a link; anything unexpected is exit 1", () => {
  mkdirSync(join(dir, "linked"));
  writeFileSync(join(dir, "target.jsonl"), readFileSync(join(dir, "proj", "ledger.jsonl")));
  symlinkSync(join(dir, "target.jsonl"), join(dir, "linked", "ledger.jsonl"));
  const before = readFileSync(join(dir, "target.jsonl"), "utf8");
  const result = film("ledger", dir, ["--ledger", "linked/ledger.jsonl", "--out", "linked", "--polled", key]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(lines(result.stderr), ["film:ledger: the ledger could not be appended to"]);
  assert.equal(readFileSync(join(dir, "target.jsonl"), "utf8"), before);
});
