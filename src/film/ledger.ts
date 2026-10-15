import { closeSync, constants, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, relative, isAbsolute } from "node:path";
import { EXIT, Refused, Unexpected, fromCaller, isMain, outProblem, parseFlags, requireFile, run, shown, writeReport } from "./lib/cli.ts";
import { type Kind, type Row, readLedger, stateOf } from "./lib/ledger.ts";

// film:ledger records what was asked of a provider and what came back (spec D6): one row per
// call appended to ledger.jsonl, never a row rewritten. `--asked <request.json>` records a
// request film:request shaped (its key, reference, attempt, provider and estimate); `--polled`,
// `--delivered --file`, `--declined` and `--failed` name the key of an asked row and carry its
// facts, with the provider's figures as returned (`--figures`, a JSON object) and a reason. A
// declined row closes the reference on every provider: film:request refuses it from then on.
// `--check <reference>` prints the reference's state. The ledger must sit inside --out, the
// one folder the command writes in.

const COMMAND = "film:ledger";
const ACTIONS = ["asked", "polled", "delivered", "declined", "failed", "check"] as const;
const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const money = (usd: number) => `$${usd.toFixed(2)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Asked = { key: string; reference: string; attempt: number; provider: string; estimate: number };

function readRequest(path: string): Asked {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    value = null;
  }
  const kit = isObject(value) ? value.kit : null;
  if (
    !isObject(value) ||
    !isObject(kit) ||
    typeof value.idempotency_key !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.idempotency_key) ||
    typeof value.estimate !== "number" ||
    typeof kit.reference !== "string" ||
    typeof kit.provider !== "string" ||
    !Number.isInteger(kit.attempt) ||
    kit.attempt < 1
  ) {
    throw new Refused(["--asked is not a request file"]);
  }
  return { key: value.idempotency_key, reference: kit.reference, attempt: kit.attempt, provider: kit.provider, estimate: value.estimate };
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
  const ts = new Date().toISOString();
  if (action === "asked") {
    const asked = readRequest(requireFile(fromCaller(target), "--asked"));
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
    if (action === "delivered" && rows.some((r) => r.kind === "delivered" && r.key === target)) {
      throw new Refused([`--delivered: key ${shown(target)} is already delivered`]);
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
    inputs: { ledger: ledgerPath, action, key: row.key, file: row.file, figures: row.figures, reason: row.reason },
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
