import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { fileURLToPath } from "node:url";
import type { RunResult } from "../../render.ts";

// The film commands' shared contract. Exit codes:
//   0 done and report written;
//   2 refused before any work, one line per problem on stdout, nothing written;
//   3 checked and failed, one line per failure on stdout, the report written;
//   1 anything unexpected, one short line on stderr, no stack trace anywhere.
// Every command writes `<name>-report.json` in --out (or beside the file it names), with `ok`,
// the inputs it used and what it produced, and writes nowhere else but the system temp folder.

export const EXIT = { done: 0, unexpected: 1, refused: 2, failed: 3 } as const;

// The kit root, from this file's place in it (src/film/lib/cli.ts); never the current directory.
export const KIT_ROOT = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
// The Python side: the film_py package lives here.
export const PY_ROOT = join(KIT_ROOT, "src", "film", "py");

const MINUTE = 60 * 1000;

// An untrusted value as it appears in a printed line: JSON-quoted, so a line break or an
// escape sequence in an input can never start a line of its own. JSON.stringify leaves
// DEL, the C1 controls and the Unicode line separators raw; those are escaped too.
export function shown(value: unknown): string {
  return printable(JSON.stringify(value) ?? String(value));
}

// JSON text made safe to print: the characters JSON.stringify leaves raw, escaped.
export function printable(json: string): string {
  return json.replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// Refused before any work (exit 2): one line per problem, printed on stdout.
export class Refused extends Error {
  constructor(readonly lines: string[]) {
    super(lines.join("; "));
  }
}

// Checked and failed (exit 3): one line per failure on stdout; the command has written its report.
export class Failed extends Error {
  constructor(readonly lines: string[]) {
    super(lines.join("; "));
  }
}

// Anything unexpected (exit 1), in the kit's own words: printed as `<command>: <message>` on stderr.
export class Unexpected extends Error {}

// The folder path arguments are resolved against: the caller's (npm sets INIT_CWD under
// `npm --prefix /opt/studio run ...`), else the current directory.
export function callerDir(): string {
  return process.env.INIT_CWD || process.cwd();
}

export function fromCaller(path: string): string {
  return resolve(callerDir(), path);
}

// node:util's parseArgs, with its complaint as one refusal line prefixed by the command.
export function parseFlags<O extends NonNullable<ParseArgsConfig["options"]>>(
  command: string,
  options: O,
  argv: string[] = process.argv.slice(2),
  allowPositionals = false,
) {
  try {
    return parseArgs({ args: argv, options, allowPositionals, strict: true });
  } catch (error) {
    // The message can quote an argument: keep it on one line.
    throw new Refused([`${command}: ${shown((error as Error).message).slice(1, -1)}`]);
  }
}

// The problem with --out, or null: it must be a folder, or not exist yet under a folder (a path
// under a file, or a dangling symlink on the way, is refused).
export function outProblem(out: string): string | null {
  let at = resolve(out);
  for (;;) {
    let present = true;
    try {
      lstatSync(at);
    } catch {
      present = false;
    }
    if (present) {
      try {
        return statSync(at).isDirectory() ? null : "--out is not a folder";
      } catch {
        return "--out is not a folder";
      }
    }
    const parent = dirname(at);
    if (parent === at) return "--out is not a folder";
    at = parent;
  }
}

// Writes a file in a folder without following a symlink at its name: the text goes to a fresh
// name first (opened exclusively), then is renamed over the final name, which replaces a link
// rather than writing through it. The folder is made if it is not there. `mode`, when given,
// is the new file's permission bits (to keep those of the file it replaces).
export function writeIn(folder: string, name: string, text: string, mode?: number): string {
  mkdirSync(folder, { recursive: true });
  const target = join(folder, name);
  const temp = join(folder, `.${name}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, text, { flag: "wx" });
    if (mode !== undefined) chmodSync(temp, mode);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  return target;
}

export type Report = { ok: boolean; inputs: Record<string, unknown>; outputs: Record<string, unknown>; [key: string]: unknown };

// `<name>-report.json` in `out`; `name` is the command without its `film:` prefix.
export function writeReport(out: string, name: string, report: Report): string {
  return writeIn(out, `${name}-report.json`, JSON.stringify(report, null, 2) + "\n");
}

// The models folder the image build filled (`FILM_MODELS`, else /opt/models).
export function modelsDir(): string {
  return process.env.FILM_MODELS || "/opt/models";
}

// The interpreter: `FILM_PYTHON` when set (the sandbox may point at its venv), else python3 on
// the path (the image puts /opt/film-venv/bin first).
const pythonCommand = () => process.env.FILM_PYTHON || "python3";

// `python3 -I -m film_py.<module>` with the kit's own src/film/py first on the path. Isolated
// mode (-I) drops the current directory, PYTHON* variables and the user's site-packages from
// the path, so `-m` alone would not find film_py; this puts back exactly one folder, the kit's.
const BOOT =
  "import runpy, sys; sys.path.insert(0, sys.argv.pop(1)); runpy.run_module(sys.argv.pop(1), run_name='__main__', alter_sys=True)";

// Runs a film_py module through the family-kill runner `render` uses: a session of its own, a
// time limit, and everything it started killed and reaped before this returns.
export async function runPython(module: string, args: string[], timeoutMs: number): Promise<RunResult> {
  if (!/^[a-z][a-z0-9_]*$/.test(module)) throw new Unexpected(`${shown(module)} is not a film_py module name`);
  // Loaded here, not at the top: render.ts brings Remotion's composition with it, which only
  // the commands that run Python pay for.
  const { runProcess } = await import("../../render.ts");
  // -B: no bytecode written beside the kit's sources; the kit writes only in --out and temp.
  return runProcess(pythonCommand(), ["-I", "-B", "-c", BOOT, PY_ROOT, `film_py.${module}`, ...args], { cwd: PY_ROOT, timeoutMs });
}

// A film_py module run to its protocol: exit 0 and one JSON document on stdout, which is
// returned; exit 2 and one refusal line per problem, thrown as Refused; anything else thrown
// as Unexpected. The module's stderr is shown only under FILM_DEBUG=1.
export async function python<T = unknown>(module: string, args: string[], timeoutMs: number): Promise<T> {
  const what = `python film_py.${module}`;
  const result = await runPython(module, args, timeoutMs);
  const debug = () => {
    if (process.env.FILM_DEBUG === "1") {
      const tail = result.stderr.split("\n").filter((line) => line.trim() !== "").slice(-40);
      if (tail.length > 0) console.error(tail.join("\n"));
    }
  };
  if (result.timedOut) throw new Unexpected(`${what} took longer than ${timeoutMs / MINUTE} minutes`);
  if (result.failure) {
    // The runner names the command as given; it comes from FILM_PYTHON, so it is printed quoted.
    const command = pythonCommand();
    const failure = result.failure.startsWith(command) ? `${shown(command)}${result.failure.slice(command.length)}` : result.failure;
    throw new Unexpected(failure);
  }
  if (result.status === EXIT.refused) {
    const lines = result.stdout.split("\n").filter((line) => line.trim() !== "");
    if (lines.length > 0) throw new Refused(lines.map((line) => printable(line)));
  }
  if (result.status !== 0) {
    debug();
    throw new Unexpected(`${what} failed`);
  }
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    debug();
    throw new Unexpected(`${what} printed no result`);
  }
}

// True when `url` (a module's import.meta.url) is the script node was asked to run.
export function isMain(url: string): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url));
  } catch {
    return false;
  }
}

// Runs a command's body and turns its outcome into the exit code and the printed lines.
// `command` is the npm script's name (`film:status`).
export function run(command: string, body: () => Promise<number>): void {
  body().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      if (error instanceof Refused || error instanceof Failed) {
        for (const line of error.lines) console.log(line);
        process.exitCode = error instanceof Refused ? EXIT.refused : EXIT.failed;
        return;
      }
      // The kit's own words only: a raw error can embed a path, a URL or a stack.
      const message = error instanceof Unexpected ? error.message : "unexpected failure";
      console.error(`${command}: ${message}`);
      process.exitCode = EXIT.unexpected;
    },
  );
}
