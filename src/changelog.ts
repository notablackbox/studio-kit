import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { shown } from "./walk.ts";

// Exit codes: 0 done, 2 refused before any work, 1 anything unexpected.
// Refusal lines go to stdout, as in walk and render; stderr carries diagnostics only.

const MONTHS =
  "January|February|March|April|May|June|July|August|September|October|November|December";
const MONTH_NAMES = MONTHS.toLowerCase().split("|");
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const LONG_DATE = new RegExp(`\\b(\\d{1,2}) (${MONTHS}) (\\d{4})\\b`, "gi");

// True when the year, month and day form a real calendar date.
function isRealDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

export function hasDate(heading: string): boolean {
  for (const [, y, m, d] of heading.matchAll(ISO_DATE)) {
    if (isRealDate(Number(y), Number(m), Number(d))) return true;
  }
  for (const [, d, name, y] of heading.matchAll(LONG_DATE)) {
    const m = MONTH_NAMES.indexOf(name.toLowerCase()) + 1;
    if (isRealDate(Number(y), m, Number(d))) return true;
  }
  return false;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripMarker(line: string): string {
  return line.trim().replace(/^(?:#+|[-*])\s*/, "");
}

export type Card = { heading: string; changes: string[]; closing: string };

// Returns null when the first line holds no date.
export function parseEntry(markdown: string): Card | null {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  if (lines.length === 0 || !hasDate(lines[0])) return null;
  const heading = stripMarker(lines[0]);
  const rest = lines.slice(1).filter((line) => line.trim() !== "");
  const closing = rest.length > 0 ? stripMarker(rest[rest.length - 1]) : "";
  const changes = rest.slice(0, -1).map(stripMarker);
  return { heading, changes, closing };
}

export function renderCard(card: Card): string {
  const parts = ['<article class="changelog-card">', `<h2>${escapeHtml(card.heading)}</h2>`];
  if (card.changes.length > 0) {
    parts.push("<ul>", ...card.changes.map((change) => `<li>${escapeHtml(change)}</li>`), "</ul>");
  }
  if (card.closing !== "") parts.push(`<p>${escapeHtml(card.closing)}</p>`);
  parts.push("</article>");
  return parts.join("\n") + "\n";
}

function main(): number {
  let values: { in?: string; out?: string };
  try {
    values = parseArgs({ options: { in: { type: "string" }, out: { type: "string" } } }).values;
  } catch (error) {
    // The message can quote an argument: keep it on one line.
    console.log(`changelog: ${shown((error as Error).message).slice(1, -1)}`);
    return 2;
  }
  if (!values.in || !values.out) {
    console.log("changelog: --in <file.md> and --out <file.html> are both required");
    return 2;
  }
  const base = process.env.INIT_CWD || process.cwd();
  const input = resolve(base, values.in);
  const output = resolve(base, values.out);
  let markdown: string;
  try {
    markdown = readFileSync(input, "utf8");
  } catch {
    console.log("changelog: cannot read the --in file");
    return 2;
  }
  const card = parseEntry(markdown);
  if (card === null) {
    console.log("changelog: the first line holds no date");
    return 2;
  }
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, renderCard(card));
  return 0;
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  try {
    process.exitCode = main();
  } catch {
    // The kit's own words only: a raw error can embed a path.
    console.error("changelog: unexpected failure");
    process.exitCode = 1;
  }
}
