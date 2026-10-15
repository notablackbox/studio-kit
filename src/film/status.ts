import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  EXIT,
  Refused,
  fromCaller,
  isMain,
  outProblem,
  parseFlags,
  printable,
  run,
  shown,
  writeIn,
  writeReport,
} from "./lib/cli.ts";

// film:status: validates a production's status.json (schema version 1), prints it and exits 0,
// or names the first wrong field and exits 2. `--set field=value ...` updates the file and bumps
// updated_at. The report, status-report.json, goes in --out, else beside the file.

const COMMAND = "film:status";

export const STAGES = [
  "brief", "song", "listen", "cast", "board", "plates", "footage", "motion", "build", "cut", "deliver", "delivered",
] as const;

export type Status = {
  version: 1;
  stage: (typeof STAGES)[number];
  step: string;
  awaiting: null | { kind: "ask" | "files"; id: string };
  expects: { key: string; name: string }[];
  sandbox_id: string;
  updated_at: string;
};

// The schema's fields, in the order they are checked.
const FIELDS = ["version", "stage", "step", "awaiting", "expects", "sandbox_id", "updated_at"] as const;
const SETTABLE = new Set<string>(["stage", "step", "awaiting", "expects", "sandbox_id"]);
const JSON_FIELDS = new Set<string>(["awaiting", "expects"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const filled = (value: unknown): value is string => typeof value === "string" && value !== "";

// A real UTC instant written YYYY-MM-DDTHH:MM:SS with optional fractions and a Z.
function isUtcTime(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z$/.exec(value);
  if (!match) return false;
  const [y, mo, d, h, mi, s] = match.slice(1, 7).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  return (
    date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d &&
    date.getUTCHours() === h && date.getUTCMinutes() === mi && date.getUTCSeconds() === s
  );
}

function unknownKey(value: Record<string, unknown>, known: string[]): string | undefined {
  return Object.keys(value).find((key) => !known.includes(key));
}

// The problem with one field's value, or null.
function fieldProblem(field: (typeof FIELDS)[number], value: unknown): string | null {
  switch (field) {
    case "version":
      return value === 1 ? null : `version is ${shown(value)}, want 1`;
    case "stage":
      return (STAGES as readonly unknown[]).includes(value) ? null : `stage is ${shown(value)}, want one of ${STAGES.join(", ")}`;
    case "step":
      return filled(value) ? null : "step must be a non-empty string";
    case "awaiting": {
      if (value === null) return null;
      if (!isObject(value)) return "awaiting must be null or {kind, id}";
      if (value.kind !== "ask" && value.kind !== "files") return `awaiting.kind is ${shown(value.kind)}, want ask or files`;
      if (!filled(value.id)) return "awaiting.id must be a non-empty string";
      const extra = unknownKey(value, ["kind", "id"]);
      return extra === undefined ? null : `awaiting has an unknown field ${shown(extra)}`;
    }
    case "expects": {
      if (!Array.isArray(value)) return "expects must be a list of {key, name}";
      for (const [i, entry] of value.entries()) {
        if (!isObject(entry)) return `expects[${i}] must be {key, name}`;
        if (!filled(entry.key)) return `expects[${i}].key must be a non-empty string`;
        if (!filled(entry.name)) return `expects[${i}].name must be a non-empty string`;
        const extra = unknownKey(entry, ["key", "name"]);
        if (extra !== undefined) return `expects[${i}] has an unknown field ${shown(extra)}`;
      }
      return null;
    }
    case "sandbox_id":
      return filled(value) ? null : "sandbox_id must be a non-empty string";
    case "updated_at":
      return isUtcTime(value) ? null : "updated_at must be a UTC time written YYYY-MM-DDTHH:MM:SS(.sss)Z";
  }
}

// The status when it is valid, else the one line naming its first wrong field: the schema's
// fields in order (missing, then wrong), then any field the schema does not have.
export function validateStatus(raw: unknown): { status?: Status; problem?: string } {
  if (!isObject(raw)) return { problem: "status file is not a JSON object" };
  for (const field of FIELDS) {
    if (!Object.hasOwn(raw, field)) return { problem: `${field} is missing` };
    const problem = fieldProblem(field, raw[field]);
    if (problem) return { problem };
  }
  const extra = unknownKey(raw, [...FIELDS]);
  if (extra !== undefined) return { problem: `unknown field ${shown(extra)}` };
  return { status: raw as Status };
}

// The --set assignments as field and value, in order; JSON for awaiting and expects.
export function parseAssignments(pairs: string[]): Record<string, unknown> {
  const set: Record<string, unknown> = {};
  for (const pair of pairs) {
    const at = pair.indexOf("=");
    if (at <= 0) throw new Refused([`--set wants field=value, got ${shown(pair)}`]);
    const field = pair.slice(0, at);
    const text = pair.slice(at + 1);
    if (field === "version" || field === "updated_at") throw new Refused(["version and updated_at are set by film:status, not --set"]);
    if (!SETTABLE.has(field)) throw new Refused([`cannot set ${shown(field)}: not a field of status.json`]);
    if (Object.hasOwn(set, field)) throw new Refused([`${field} is set twice`]);
    if (JSON_FIELDS.has(field)) {
      try {
        set[field] = JSON.parse(text);
      } catch {
        throw new Refused([field === "awaiting" ? "awaiting must be JSON: null or {kind, id}" : "expects must be JSON: a list of {key, name}"]);
      }
    } else {
      set[field] = text;
    }
  }
  return set;
}

async function main(): Promise<number> {
  const { values, positionals } = parseFlags(
    COMMAND,
    { status: { type: "string" }, out: { type: "string" }, set: { type: "string", multiple: true } },
    process.argv.slice(2),
    true,
  );
  if (!values.status) throw new Refused([`${COMMAND}: --status <path> is required`]);
  // Pairs after --set's own value arrive as positionals: `--set stage=listen step=beats`.
  if (positionals.length > 0 && !values.set) {
    throw new Refused([`unexpected argument ${shown(positionals[0])} (field=value pairs follow --set)`]);
  }
  const set = parseAssignments([...(values.set ?? []), ...positionals]);

  const file = fromCaller(values.status);
  const out = values.out ? fromCaller(values.out) : dirname(file);
  let raw: unknown;
  let original = "";
  try {
    original = readFileSync(file, "utf8");
    raw = JSON.parse(original);
  } catch {
    throw new Refused(["status file cannot be read as JSON"]);
  }
  const current = validateStatus(raw);
  if (!current.status) throw new Refused([current.problem!]);
  const problem = outProblem(out);
  if (problem) throw new Refused([problem]);
  if (isReportPath(file, out)) {
    throw new Refused(["--status is the report's path (status-report.json in --out): the report would overwrite it"]);
  }

  let status = current.status;
  const changing = Object.keys(set).length > 0;
  if (changing) {
    // Always later than the time it replaces, even under a clock that stepped back.
    const updated = new Date(Math.max(Date.now(), Date.parse(status.updated_at) + 1)).toISOString();
    const next = validateStatus({ ...status, ...set, updated_at: updated });
    if (!next.status) throw new Refused([next.problem!]);
    status = next.status;
  }
  const report = () =>
    writeReport(out, "status", {
      ok: true,
      inputs: { status: file, set },
      outputs: { status: changing ? file : null, report: "status-report.json" },
      status,
    });
  if (!changing) {
    report();
  } else {
    // The new file keeps the old one's permissions. Should the report then fail, the old text
    // is put back, so an exit 1 never leaves a changed status.json behind.
    const mode = statSync(file).mode & 0o7777;
    writeIn(dirname(file), basename(file), JSON.stringify(status, null, 2) + "\n", mode);
    try {
      report();
    } catch (error) {
      writeIn(dirname(file), basename(file), original, mode);
      throw error;
    }
  }
  console.log(printable(JSON.stringify(status, null, 2)));
  return EXIT.done;
}

// Whether the status file and the report are one file: both are written into their folder by
// name (a rename that replaces a link at the name), so the folders are compared through their
// real paths and the names as given. An --out not made yet cannot hold the status file.
function isReportPath(file: string, out: string): boolean {
  if (basename(file) !== "status-report.json") return false;
  try {
    return join(realpathSync(dirname(file)), basename(file)) === join(realpathSync(out), "status-report.json");
  } catch {
    return false;
  }
}

if (isMain(import.meta.url)) run(COMMAND, main);
