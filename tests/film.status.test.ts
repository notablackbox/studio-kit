import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const kitRoot = fileURLToPath(new URL("..", import.meta.url));

// Every temp folder a test makes is removed once the file's tests are done.
const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "studio-kit-film-status-"));
  temps.push(dir);
  return dir;
}

const VALID = {
  version: 1,
  project: "city-wakes-a1b2c3",
  stage: "board",
  step: "audit",
  awaiting: { kind: "ask", id: "board-approval" },
  expects: [{ key: "approve", name: "Approve the board" }],
  sandbox_id: "sbx-test-0001",
  updated_at: "2026-10-15T08:00:00.000Z",
};

// A project folder holding status.json (raw text, or a value written as JSON).
function project(content: unknown = VALID) {
  const dir = tempDir();
  const file = join(dir, "status.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return { dir, file };
}

function status(dir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/film/status.ts", ...args], {
    cwd: kitRoot,
    encoding: "utf8",
    env: { ...process.env, INIT_CWD: dir, ...env },
  });
}

const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "");

test("a valid file exits 0, prints the file and writes status-report.json beside it", () => {
  const { dir, file } = project();
  const result = status(dir, ["--status", "status.json"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), VALID);
  const report = JSON.parse(readFileSync(join(dir, "status-report.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.deepEqual(report.inputs, { status: file, set: {} });
  assert.deepEqual(report.outputs, { status: null, report: "status-report.json" });
  assert.deepEqual(report.status, VALID);
  // Validating writes nothing else and leaves the file as it was.
  assert.deepEqual(readdirSync(dir).sort(), ["status-report.json", "status.json"]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), VALID);
});

test("--out puts the report in that folder, made if it is not there yet", () => {
  const { dir } = project();
  const result = status(dir, ["--status", "status.json", "--out", "reports/today"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, "reports", "today", "status-report.json"), "utf8")).ok, true);
  assert.equal(existsSync(join(dir, "status-report.json")), false);
});

test("the npm script runs it as the sandbox calls it: npm --prefix <kit> run film:status, from the caller's folder", () => {
  const { dir } = project();
  // npm sets INIT_CWD to the folder it was called from, which the relative path resolves against.
  const env = { ...process.env };
  delete env.INIT_CWD;
  const result = spawnSync("npm", ["--prefix", kitRoot, "run", "--silent", "film:status", "--", "--status", "status.json"], {
    cwd: dir,
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), VALID);
});

test("null awaiting and an empty expects list are valid", () => {
  const { dir } = project({ ...VALID, awaiting: null, expects: [] });
  assert.equal(status(dir, ["--status", "status.json"]).status, 0);
});

// Each refused file and the one line naming its first wrong field.
const without = (key: keyof typeof VALID) => Object.fromEntries(Object.entries(VALID).filter(([k]) => k !== key));
const refusedFiles: [string, unknown, string][] = [
  ["not JSON", "{ nope", "status file cannot be read as JSON"],
  ["a list", "[]", "status file is not a JSON object"],
  ["an older version", { ...VALID, version: 0 }, "version is 0, want 1"],
  ["a newer version", { ...VALID, version: 2 }, "version is 2, want 1"],
  ["no version", without("version"), "version is missing"],
  ["no project", without("project"), "project is missing"],
  ["a project missing, the stage also wrong: project is named first", { ...without("project"), stage: "nowhere" }, "project is missing"],
  ["a project in capitals", { ...VALID, project: "City Wakes" }, "project must match [a-z0-9][a-z0-9-]{0,63}"],
  ["a project with a leading dash", { ...VALID, project: "-city" }, "project must match [a-z0-9][a-z0-9-]{0,63}"],
  ["a project of 65 characters", { ...VALID, project: "a".repeat(65) }, "project must match [a-z0-9][a-z0-9-]{0,63}"],
  ["a numeric project", { ...VALID, project: 7 }, "project must match [a-z0-9][a-z0-9-]{0,63}"],
  ["a partial file (no expects)", without("expects"), "expects is missing"],
  ["a partial file (no updated_at)", without("updated_at"), "updated_at is missing"],
  [
    "an unknown stage",
    { ...VALID, stage: "mastering" },
    'stage is "mastering", want one of brief, song, listen, cast, board, plates, footage, motion, build, cut, deliver, delivered',
  ],
  ["an empty step", { ...VALID, step: "" }, "step must be a non-empty string"],
  ["awaiting of an unknown kind", { ...VALID, awaiting: { kind: "wait", id: "x" } }, 'awaiting.kind is "wait", want ask or files'],
  ["awaiting with no id", { ...VALID, awaiting: { kind: "files" } }, "awaiting.id must be a non-empty string"],
  ["awaiting as a string", { ...VALID, awaiting: "ask" }, "awaiting must be null or {kind, id}"],
  ["awaiting with an extra field", { ...VALID, awaiting: { kind: "ask", id: "x", due: 1 } }, 'awaiting has an unknown field "due"'],
  ["expects not a list", { ...VALID, expects: {} }, "expects must be a list of {key, name}"],
  ["an expects entry with no name", { ...VALID, expects: [{ key: "a", name: "A" }, { key: "b" }] }, "expects[1].name must be a non-empty string"],
  ["an expects entry with an extra field", { ...VALID, expects: [{ key: "a", name: "A", x: 1 }] }, 'expects[0] has an unknown field "x"'],
  ["a numeric sandbox_id", { ...VALID, sandbox_id: 7 }, "sandbox_id must be a non-empty string"],
  ["updated_at not a UTC time", { ...VALID, updated_at: "yesterday" }, "updated_at must be a UTC time written YYYY-MM-DDTHH:MM:SS(.sss)Z"],
  ["updated_at an impossible date", { ...VALID, updated_at: "2026-02-30T08:00:00Z" }, "updated_at must be a UTC time written YYYY-MM-DDTHH:MM:SS(.sss)Z"],
  ["an unknown field", { ...VALID, colour: "red" }, 'unknown field "colour"'],
];

for (const [label, content, line] of refusedFiles) {
  test(`${label}: exit 2, one line naming it, nothing written`, () => {
    const { dir, file } = project(content);
    const before = readFileSync(file, "utf8");
    const result = status(dir, ["--status", "status.json"]);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.deepEqual(lines(result.stdout), [line]);
    assert.equal(result.stderr, "");
    assert.deepEqual(readdirSync(dir), ["status.json"]);
    assert.equal(readFileSync(file, "utf8"), before);
  });
}

test("only the first wrong field is named, in the schema's order", () => {
  const { dir } = project({ ...VALID, colour: "red", expects: "x", stage: "nope" });
  const result = status(dir, ["--status", "status.json"]);
  assert.equal(result.status, 2);
  assert.equal(lines(result.stdout).length, 1);
  assert.match(result.stdout, /^stage is "nope"/);
});

test("a hostile value is printed JSON-quoted on one line", () => {
  const { dir } = project({ ...VALID, stage: "x\nforged line\u2028more" });
  const result = status(dir, ["--status", "status.json"]);
  assert.equal(result.status, 2);
  assert.deepEqual(lines(result.stdout), [
    'stage is "x\\nforged line\\u2028more", want one of brief, song, listen, cast, board, plates, footage, motion, build, cut, deliver, delivered',
  ]);
});

test("--set stage and step updates the file, keeps the rest and bumps updated_at", () => {
  const { dir, file } = project();
  const startedAt = Date.now();
  const result = status(dir, ["--status", "status.json", "--set", "stage=listen", "step=beats"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(written.stage, "listen");
  assert.equal(written.step, "beats");
  assert.deepEqual(written.awaiting, VALID.awaiting);
  assert.deepEqual(written.expects, VALID.expects);
  assert.equal(written.sandbox_id, VALID.sandbox_id);
  assert.equal(written.version, 1);
  assert.match(written.updated_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.ok(Date.parse(written.updated_at) >= startedAt - 1000, written.updated_at);
  assert.ok(Date.parse(written.updated_at) > Date.parse(VALID.updated_at));
  assert.deepEqual(JSON.parse(result.stdout), written);
  const report = JSON.parse(readFileSync(join(dir, "status-report.json"), "utf8"));
  assert.deepEqual(report.inputs.set, { stage: "listen", step: "beats" });
  assert.equal(report.outputs.status, file);
  assert.deepEqual(readdirSync(dir).sort(), ["status-report.json", "status.json"]);
});

test("--set takes JSON for awaiting and expects, and repeated --set flags", () => {
  const { dir, file } = project();
  const result = status(dir, [
    "--status", "status.json",
    "--set", 'awaiting={"kind":"files","id":"master"}',
    "--set", 'expects=[{"key":"master","name":"The master WAV"}]',
    "sandbox_id=sbx-test-0002",
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(written.awaiting, { kind: "files", id: "master" });
  assert.deepEqual(written.expects, [{ key: "master", name: "The master WAV" }]);
  assert.equal(written.sandbox_id, "sbx-test-0002");

  const cleared = status(dir, ["--status", "status.json", "--set", "awaiting=null"]);
  assert.equal(cleared.status, 0, cleared.stdout + cleared.stderr);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).awaiting, null);
});

// Each refused --set, its one line, and the file left exactly as it was.
const refusedSets: [string[], string][] = [
  [["--set", "colour=red"], 'cannot set "colour": not a field of status.json'],
  [["--set", "project=other-id"], "--set cannot set project"],
  [["--set", "version=2"], "version and updated_at are set by film:status, not --set"],
  [["--set", "updated_at=2030-01-01T00:00:00Z"], "version and updated_at are set by film:status, not --set"],
  [["--set", "stage"], '--set wants field=value, got "stage"'],
  [["--set", "stage=listen", "stage=board"], "stage is set twice"],
  [["--set", "stage=mastering"], 'stage is "mastering", want one of brief, song, listen, cast, board, plates, footage, motion, build, cut, deliver, delivered'],
  [["--set", "awaiting={nope"], "awaiting must be JSON: null or {kind, id}"],
  [["--set", "expects=[{\"key\":\"a\"}]"], "expects[0].name must be a non-empty string"],
  [["step=x"], 'unexpected argument "step=x" (field=value pairs follow --set)'],
];

for (const [args, line] of refusedSets) {
  test(`refused set ${JSON.stringify(args)}: exit 2, one line, the file untouched`, () => {
    const { dir, file } = project();
    const before = readFileSync(file, "utf8");
    const result = status(dir, ["--status", "status.json", ...args]);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.deepEqual(lines(result.stdout), [line]);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.deepEqual(readdirSync(dir), ["status.json"]);
  });
}

test("--set on an invalid file is refused for the file's first wrong field", () => {
  const { dir } = project(without("sandbox_id"));
  const result = status(dir, ["--status", "status.json", "--set", "stage=listen"]);
  assert.equal(result.status, 2);
  assert.deepEqual(lines(result.stdout), ["sandbox_id is missing"]);
});

test("flag refusals are one line each on stdout, prefixed with the command", () => {
  const dir = tempDir();
  const cases: [string[], RegExp][] = [
    [[], /^film:status: --status <path> is required$/],
    [["--status"], /^film:status: /],
    [["--nope\nforged"], /^film:status: /],
    [["--status", "missing.json"], /^status file cannot be read as JSON$/],
  ];
  for (const [args, pattern] of cases) {
    const result = status(dir, args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.equal(lines(result.stdout).length, 1, JSON.stringify(result.stdout));
    assert.match(lines(result.stdout)[0], pattern);
    assert.equal(result.stderr, "");
  }
  assert.deepEqual(readdirSync(dir), []);
});

test("--out that is a file is refused before anything is written", () => {
  const { dir, file } = project();
  writeFileSync(join(dir, "taken"), "a file");
  const before = readFileSync(file, "utf8");
  const result = status(dir, ["--status", "status.json", "--out", "taken", "--set", "stage=listen"]);
  assert.equal(result.status, 2);
  assert.deepEqual(lines(result.stdout), ["--out is not a folder"]);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("a status file that is the report's own path is refused, the file untouched", () => {
  const dir = tempDir();
  const file = join(dir, "status-report.json");
  writeFileSync(file, JSON.stringify(VALID, null, 2));
  const before = readFileSync(file, "utf8");
  const cases: string[][] = [
    ["--status", "status-report.json"],
    ["--status", "status-report.json", "--set", "stage=listen"],
    ["--status", "status-report.json", "--out", "."],
    ["--status", "./sub/../status-report.json", "--out", dir],
  ];
  for (const args of cases) {
    const result = status(dir, args);
    assert.equal(result.status, 2, `${JSON.stringify(args)}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(lines(result.stdout), [
      "--status is the report's path (status-report.json in --out): the report would overwrite it",
    ]);
    assert.equal(readFileSync(file, "utf8"), before);
    assert.deepEqual(readdirSync(dir), ["status-report.json"]);
  }
  // Elsewhere, the same file is fine.
  const ok = status(dir, ["--status", "status-report.json", "--out", "reports"]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("an unexpected failure exits 1 with one short line on stderr and nothing on stdout", () => {
  const { dir } = project();
  // A folder where the report goes: the rename onto it fails.
  mkdirSync(join(dir, "status-report.json"));
  const result = status(dir, ["--status", "status.json"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(lines(result.stderr), ["film:status: unexpected failure"]);
  // No temp file is left behind.
  assert.deepEqual(readdirSync(dir).sort(), ["status-report.json", "status.json"]);
});

test("a --set whose report cannot be written exits 1 and leaves status.json as it was", () => {
  const { dir, file } = project();
  const before = readFileSync(file, "utf8");
  mkdirSync(join(dir, "status-report.json"));
  const result = status(dir, ["--status", "status.json", "--set", "stage=listen", "step=beats"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(lines(result.stderr), ["film:status: unexpected failure"]);
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual(readdirSync(dir).sort(), ["status-report.json", "status.json"]);
});

test("--set keeps the file's permissions", () => {
  const { dir, file } = project();
  chmodSync(file, 0o640);
  const result = status(dir, ["--status", "status.json", "--set", "stage=listen"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).stage, "listen");
  assert.equal(statSync(file).mode & 0o777, 0o640);
});

test("importing status.ts runs nothing: no output, no exit code", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", 'const m = await import("./src/film/status.ts"); if (typeof m.validateStatus !== "function") process.exit(9);'],
    { cwd: kitRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
