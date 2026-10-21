import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { Refused } from "./cli.ts";

// ledger.jsonl, the record of every paid call (spec D6, wiki/formats "The logs"): one JSON row
// per line, appended by film:ledger and never rewritten, read by film:request. A row is
// {ts, kind, key, reference, attempt, provider, estimate, figures, file, reason}; `kind` is
// asked, polled, delivered, declined or failed. Every row but `asked` names the key of an
// `asked` row and carries its reference, attempt, provider and estimate. A `declined` row
// closes its reference on every provider.

export const KINDS = ["asked", "polled", "delivered", "declined", "failed"] as const;
export type Kind = (typeof KINDS)[number];

export type Row = {
  ts: string;
  kind: Kind;
  key: string;
  reference: string;
  attempt: number;
  provider: string;
  estimate: number | null;
  figures: Record<string, unknown> | null;
  file: string | null;
  reason: string | null;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function rowOf(value: unknown): Row | null {
  if (!isObject(value)) return null;
  const { ts, kind, key, reference, attempt, provider, estimate, figures, file, reason } = value;
  if (typeof ts !== "string" || typeof key !== "string" || typeof reference !== "string" || typeof provider !== "string") return null;
  if (!KINDS.includes(kind as Kind)) return null;
  if (typeof attempt !== "number" || !Number.isInteger(attempt) || attempt < 1) return null;
  if (estimate !== null && typeof estimate !== "number") return null;
  if (figures !== null && !isObject(figures)) return null;
  if (file !== null && typeof file !== "string") return null;
  if (reason !== null && typeof reason !== "string") return null;
  return value as Row;
}

// The ledger's rows; an absent file is an empty ledger (no call made yet). A line that is not a
// row is refused with its number.
export function readLedger(path: string, flag = "--ledger"): Row[] {
  let text: string;
  try {
    if (!statSync(path).isFile()) throw new Refused([`${flag} cannot be read`]);
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Refused) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Refused([`${flag} cannot be read`]);
  }
  const rows: Row[] = [];
  const lines = text.split("\n");
  for (const [n, line] of lines.entries()) {
    if (line.trim() === "") continue;
    let row: Row | null = null;
    try {
      row = rowOf(JSON.parse(line));
    } catch {
      row = null;
    }
    if (!row) throw new Refused([`${flag} line ${n + 1} is not a ledger row`]);
    rows.push(row);
  }
  return rows;
}

export type State = {
  reference: string;
  attempts: number;
  last_kind: Kind | null;
  last_key: string | null;
  declined_on: string[];
  delivered: { key: string; attempt: number; provider: string; file: string | null }[];
  estimate_total: number;
};

// What the ledger says of one reference: how many requests were asked, the last row's kind, the
// providers that declined it, the takes delivered and the sum of the estimates asked.
export function stateOf(rows: Row[], reference: string): State {
  const mine = rows.filter((r) => r.reference === reference);
  const asked = mine.filter((r) => r.kind === "asked");
  const last = mine.at(-1);
  return {
    reference,
    attempts: asked.length,
    last_kind: last?.kind ?? null,
    last_key: last?.key ?? null,
    declined_on: [...new Set(mine.filter((r) => r.kind === "declined").map((r) => r.provider))],
    delivered: mine.filter((r) => r.kind === "delivered").map((r) => ({ key: r.key, attempt: r.attempt, provider: r.provider, file: r.file })),
    estimate_total: Math.round(asked.reduce((sum, r) => sum + (r.estimate ?? 0), 0) * 100) / 100,
  };
}

// JSON with every object's keys sorted, no spaces: the same value always gives the same text.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

// The production id (status.json's `project`): lowercase letters, digits and dashes, the first
// not a dash, 64 at most. film:status checks it and minted once; the key below carries it.
export const PROJECT = /^[a-z0-9][a-z0-9-]{0,63}$/;

// The production the ledger belongs to: the `project` of the status.json beside it.
export function readProject(ledgerPath: string): string {
  try {
    const { project } = JSON.parse(readFileSync(join(dirname(ledgerPath), "status.json"), "utf8"));
    if (typeof project === "string" && PROJECT.test(project)) return project;
  } catch {
    // missing, unreadable or not JSON: refused below with the rest
  }
  throw new Refused(["status.json beside --ledger has no project: run film:status on it"]);
}

// The idempotency key of a request (spec 8.2, D6, v1.4 section 6): SHA-256 of the canonical JSON
// of the production id, the provider, the model, the body and the attempt number. The same
// request asked again gets the same key, so call_external reconciles it instead of paying
// twice; a re-roll is the next attempt and gets a new key; two productions of one brief never
// share a key.
export function idempotencyKey(project: string, provider: string, model: string, body: unknown, attempt: number): string {
  return createHash("sha256").update(canonical({ attempt, body, model, project, provider })).digest("hex");
}
