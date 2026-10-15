import { closeSync, constants, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, relative, isAbsolute } from "node:path";
import { EXIT, Refused, Unexpected, fromCaller, isMain, outProblem, parseFlags, requireFile, run, shown, writeReport } from "./lib/cli.ts";
import { type Kind, type Row, idempotencyKey, readLedger, stateOf } from "./lib/ledger.ts";

// film:ledger records what was asked of a provider and what came back (spec D6): one row per
// call appended to ledger.jsonl, never a row rewritten. `--asked <request.json> [--meta <file>]`
// records a request film:request shaped, with its meta file (by default the sibling
// <id>.request.meta.json): the key, recomputed from the request's body and the meta's
// provider, model and attempt, and the reference, attempt, provider and estimate. `--polled`,
// `--delivered --file`, `--declined` and `--failed` name the key of an asked row and carry its
// facts, with the provider's figures as returned (`--figures`, a JSON object) and a reason. A
// declined row closes the reference on every provider: film:request refuses it from then on,
// and so does this command for any row but the decline's own (a delivered key cannot be
// declined either).
// `--check <reference>` prints the reference's state. The ledger must sit inside --out, the
// one folder the command writes in.

const COMMAND = "film:ledger";
const ACTIONS = ["asked", "polled", "delivered", "declined", "failed", "check"] as const;
const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const money = (usd: number) => `$${usd.toFixed(2)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Asked = { key: string; reference: string; attempt: number; provider: string; estimate: number };

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// The request (call_external's input) and its meta file, checked against each other: the key
// must be the one the body, the provider, the model and the attempt give.
function readRequest(requestPath: string, metaPath: string): Asked {
  const request = readJson(requestPath);
  if (!isObject(request) || typeof request.idempotency_key !== "string" || !/^[0-9a-f]{64}$/.test(request.idempotency_key) || typeof request.estimate !== "number" || !isObject(request.body)) {
    throw new Refused(["--asked is not a request file"]);
  }
  const meta = readJson(requireFile(metaPath, "--meta"));
  if (
    !isObject(meta) ||
    typeof meta.reference !== "string" ||
    typeof meta.provider !== "string" ||
    typeof meta.model !== "string" ||
    !Number.isInteger(meta.attempt) ||
    meta.attempt < 1
  ) {
    throw new Refused(["--meta is not a request meta file"]);
  }
  if (idempotencyKey(meta.provider, meta.model, request.body, meta.attempt) !== request.idempotency_key) {
    throw new Refused([`--asked: the idempotency_key is not the key of the body, provider, model and attempt ${meta.attempt}`]);
  }
  return { key: request.idempotency_key, reference: meta.reference, attempt: meta.attempt, provider: meta.provider, estimate: request.estimate };
}

// Appends one line, never through a link at the ledger's name (O_NOFOLLOW), never truncating.
function append(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
  } catch {
    throw new Unexpected("the ledger could not be appended to");
  }
  try {
    writeSync(fd, line);
  } catch {
    throw new Unexpected("the ledger could not be appended to");
  } finally {
    closeSync(fd);
  }
}

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, {
    ledger: { type: "string" },
    out: { type: "string" },
    asked: { type: "string" },
    polled: { type: "string" },
    delivered: { type: "string" },
    declined: { type: "string" },
    failed: { type: "string" },
    check: { type: "string" },
    file: { type: "string" },
    figures: { type: "string" },
    reason: { type: "string" },
    meta: { type: "string" },
  });
  const given = ACTIONS.filter((a) => values[a] !== undefined);
  if (!values.ledger || !values.out || given.length === 0) {
    throw new Refused([`${COMMAND}: --ledger, --out and one of --asked, --polled, --delivered, --declined, --failed or --check are required`]);
  }
  if (given.length > 1) throw new Refused([`${COMMAND}: give one of --asked, --polled, --delivered, --declined, --failed or --check`]);
  const action = given[0];
  const target = values[action]!;
  if (action === "delivered" && values.file === undefined) throw new Refused(["--delivered needs --file <path>"]);
  if (action !== "delivered" && values.file !== undefined) throw new Refused(["--file goes with --delivered only"]);
  if (action !== "asked" && values.meta !== undefined) throw new Refused(["--meta goes with --asked only"]);
  if ((action === "asked" || action === "check") && (values.figures !== undefined || values.reason !== undefined)) {
    throw new Refused(["--figures and --reason go with the rows after asked"]);
  }
  let figures: Record<string, unknown> | null = null;
  if (values.figures !== undefined) {
    try {
      figures = JSON.parse(values.figures);
    } catch {
      figures = null;
    }
    if (!isObject(figures)) throw new Refused(["--figures is not a JSON object"]);
  }
  if (values.file !== undefined) requireFile(fromCaller(values.file), "--file");

  const out = fromCaller(values.out);
  const problem = outProblem(out);
  if (problem) throw new Refused([problem]);
  const ledgerPath = fromCaller(values.ledger);
  const inside = relative(out, ledgerPath);
  if (action !== "check" && (inside === "" || inside.startsWith("..") || isAbsolute(inside))) {
    throw new Refused(["--ledger must be inside --out (the ledger is appended to)"]);
  }
  const rows = readLedger(ledgerPath);

  if (action === "check") {
    const state = stateOf(rows, target);
    writeReport(out, "ledger", {
      ok: true,
      inputs: { ledger: ledgerPath, action, reference: target },
      outputs: { report: "ledger-report.json" },
      state,
    });
    const declined = state.declined_on.length > 0 ? state.declined_on.join(" and ") : "none";
    console.log(`ledger: ${shown(target)}: ${plural(state.attempts, "attempt")}, last ${state.last_kind ?? "none"}, declined on ${declined}, ${money(state.estimate_total)} asked`);
    return EXIT.done;
  }

  let row: Row;
  let metaPath: string | null = null;
  const ts = new Date().toISOString();
  if (action === "asked") {
    const requestPath = requireFile(fromCaller(target), "--asked");
    metaPath = values.meta !== undefined ? fromCaller(values.meta) : requestPath.replace(/(\.json)?$/i, ".meta.json");
    const asked = readRequest(requestPath, metaPath);
    if (rows.some((r) => r.key === asked.key)) throw new Refused([`--asked: key ${shown(asked.key)} is already in the ledger`]);
    const state = stateOf(rows, asked.reference);
    if (state.declined_on.length > 0) {
      throw new Refused([`--asked: ${shown(asked.reference)} was declined on ${state.declined_on.join(" and ")}: no request for it on any provider`]);
    }
    if (asked.attempt !== state.attempts + 1) {
      throw new Refused([`--asked: ${shown(asked.reference)} attempt ${asked.attempt} is stale, the ledger holds ${state.attempts} asked: shape the request again`]);
    }
    row = { ts, kind: "asked", key: asked.key, reference: asked.reference, attempt: asked.attempt, provider: asked.provider, estimate: asked.estimate, figures: null, file: null, reason: null };
  } else {
    const origin = rows.find((r) => r.kind === "asked" && r.key === target);
    if (!origin) throw new Refused([`--${action}: key ${shown(target)} is not in the ledger`]);
    if ((action === "delivered" || action === "declined") && rows.some((r) => r.kind === "delivered" && r.key === target)) {
      throw new Refused([`--${action}: key ${shown(target)} is already delivered`]);
    }
    // A declined reference is terminal: nothing after the decline but another decline.
    const closedOn = stateOf(rows, origin.reference).declined_on;
    if (action !== "declined" && closedOn.length > 0) {
      throw new Refused([`--${action}: ${shown(origin.reference)} was declined on ${closedOn.join(" and ")}: the reference is closed`]);
    }
    row = {
      ts,
      kind: action as Kind,
      key: target,
      reference: origin.reference,
      attempt: origin.attempt,
      provider: origin.provider,
      estimate: origin.estimate,
      figures,
      file: values.file ?? null,
      reason: values.reason ?? null,
    };
  }

  append(ledgerPath, JSON.stringify(row) + "\n");
  const state = stateOf([...rows, row], row.reference);
  writeReport(out, "ledger", {
    ok: true,
    inputs: { ledger: ledgerPath, action, key: row.key, meta: metaPath, file: row.file, figures: row.figures, reason: row.reason },
    outputs: { ledger: relative(out, ledgerPath), report: "ledger-report.json" },
    row,
    state,
  });
  const head = `ledger: ${row.kind} ${shown(row.reference)} attempt ${row.attempt} on ${row.provider}`;
  const tail =
    row.kind === "asked"
      ? `, estimate ${money(row.estimate ?? 0)}`
      : row.kind === "delivered"
        ? `: ${shown(row.file)}`
        : row.kind === "declined"
          ? `: ${shown(row.reference)} is closed on every provider`
          : "";
  console.log(head + tail);
  return EXIT.done;
}

if (isMain(import.meta.url)) run(COMMAND, main);
