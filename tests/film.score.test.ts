import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "studio-kit-film-score-"));
  temps.push(dir);
  return dir;
}

// File line numbers are given in the comments; cues and blank lines are skipped.
const SHEET = [
  "[Verse 1 - spoken, deadpan]", //                      1
  "The city wakes before the morning light comes in", // 2: 12 syllables
  "We count the windows as they open one by one", //     3: 12
  "", //                                                 4
  "[Chorus - sung]", //                                  5
  "Hold on", //                                          6: 2 (sung: no length lint)
  "Hold the light", //                                   7: 3
  "[Verse 2 - spoken]", //                               8
  "We sold 3 records", //                                9: 5, a digit
  "The AGI reads the glorbo files", //                  10: 9, an acronym, a word not in the dictionary
  "",
].join("\n");

function score(dir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/film/score.ts", ...args], {
    cwd: kitRoot,
    encoding: "utf8",
    env: { ...process.env, INIT_CWD: dir, ...env },
  });
}

function sheet(text = SHEET) {
  const dir = tempDir();
  writeFileSync(join(dir, "lyrics.txt"), text);
  return dir;
}

const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "");

test("each lyric line gets its syllables and stresses; cues are skipped", () => {
  const dir = sheet();
  const result = score(dir, ["--lyrics", "lyrics.txt", "--out", "out"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(readFileSync(join(dir, "out", "score-report.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.deepEqual(report.inputs, { lyrics: join(dir, "lyrics.txt") });
  assert.deepEqual(report.outputs, { report: "score-report.json" });

  assert.deepEqual(
    report.lines.map((l: { line: number; syllables: number }) => [l.line, l.syllables]),
    [[2, 12], [3, 12], [6, 2], [7, 3], [9, 5], [10, 9]],
  );
  for (const l of report.lines) {
    assert.equal(l.stresses.length, l.syllables, `line ${l.line}`);
    assert.match(l.stresses, /^[012]+$/);
    assert.equal(l.words.reduce((n: number, w: { syllables: number }) => n + w.syllables, 0), l.syllables);
    assert.ok(Number.isInteger(l.scansion) && l.scansion >= 0 && l.scansion <= 100, `line ${l.line} scansion ${l.scansion}`);
    assert.ok(Number.isInteger(l.assonance) && l.assonance >= 0 && l.assonance <= 100, `line ${l.line} assonance ${l.assonance}`);
  }
  assert.deepEqual(
    report.lines.map((l: { section: string; delivery: string }) => [l.section, l.delivery]),
    [
      ["Verse 1", "spoken"], ["Verse 1", "spoken"],
      ["Chorus", "sung"], ["Chorus", "sung"],
      ["Verse 2", "spoken"], ["Verse 2", "spoken"],
    ],
  );

  const city = report.lines[0].words[1];
  assert.deepEqual(city, { word: "city", syllables: 2, stresses: "10", source: "cmudict" });
  const glorbo = report.lines[5].words.find((w: { word: string }) => w.word === "glorbo");
  assert.equal(glorbo.source, "fallback");
  assert.equal(glorbo.syllables, 2);
  const agi = report.lines[5].words.find((w: { word: string }) => w.word === "AGI");
  assert.equal(agi.syllables, 3, "an acronym is spoken letter by letter");

  assert.deepEqual(report.sections.map((s: { name: string; lines: number[] }) => [s.name, s.lines]), [
    ["Verse 1", [2, 3]],
    ["Chorus", [6, 7]],
    ["Verse 2", [9, 10]],
  ]);
  for (const value of [report.scansion, report.assonance, ...report.sections.flatMap((s: { scansion: number; assonance: number }) => [s.scansion, s.assonance])]) {
    assert.ok(Number.isInteger(value) && value >= 0 && value <= 100, String(value));
  }
});

test("the lint names spoken lines outside 10 to 13 syllables, digits and all-caps acronyms", () => {
  const dir = sheet();
  const result = score(dir, ["--lyrics", "lyrics.txt", "--out", "out"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(readFileSync(join(dir, "out", "score-report.json"), "utf8"));
  assert.deepEqual(
    report.lint.map((l: { line: number; kind: string }) => [l.line, l.kind]),
    [[9, "syllables"], [9, "digit"], [10, "syllables"], [10, "acronym"]],
  );
  const expected = [
    "line 9: spoken line of 5 syllables, want 10 to 13",
    'line 9: digit in "3": spell numbers out',
    "line 10: spoken line of 9 syllables, want 10 to 13",
    'line 10: all-caps "AGI": spell an acronym out ("A G I")',
  ];
  assert.deepEqual(report.lint.map((l: { message: string }) => l.message), expected);
  // stdout: one summary line, then the lint, one line each.
  const out = lines(result.stdout);
  assert.match(out[0], /^score: 6 lines in 3 sections, scansion \d+, assonance \d+, 4 lint$/);
  assert.deepEqual(out.slice(1), expected);
});

test("a clean sheet has no lint, and the report is the same on every run", () => {
  const clean = ["[Verse - spoken]", "The city wakes before the morning light comes in", "We count the windows as they open one by one", ""].join("\n");
  const dir = sheet(clean);
  const first = score(dir, ["--lyrics", "lyrics.txt", "--out", "a"]);
  const second = score(dir, ["--lyrics", "lyrics.txt", "--out", "b"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const a = JSON.parse(readFileSync(join(dir, "a", "score-report.json"), "utf8"));
  const b = JSON.parse(readFileSync(join(dir, "b", "score-report.json"), "utf8"));
  assert.deepEqual(a.lint, []);
  assert.deepEqual({ ...a, outputs: null }, { ...b, outputs: null });
  assert.equal(lines(first.stdout).length, 1);
});

test("the Python side writes no bytecode into the kit", () => {
  const cache = join(kitRoot, "src", "film", "py", "film_py", "__pycache__");
  rmSync(cache, { recursive: true, force: true });
  const dir = sheet();
  const result = score(dir, ["--lyrics", "lyrics.txt", "--out", "out"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(cache), false);
});

test("refusals: one line each on stdout, exit 2, nothing written", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "cues.txt"), "[Verse - spoken]\n\n[Chorus - sung]\n");
  writeFileSync(join(dir, "lyrics.txt"), "Hold on\n");
  writeFileSync(join(dir, "taken"), "a file");
  writeFileSync(join(dir, "huge.txt"), "la ".repeat(30_000));
  const cases: [string[], RegExp][] = [
    [[], /^film:score: --lyrics <path> and --out <dir> are required$/],
    [["--lyrics", "lyrics.txt"], /^film:score: --lyrics <path> and --out <dir> are required$/],
    [["--lyrics", "lyrics.txt", "--out", "out", "--nope"], /^film:score: /],
    [["--lyrics", "missing.txt", "--out", "out"], /^lyrics file cannot be read$/],
    [["--lyrics", "cues.txt", "--out", "out"], /^lyrics file holds no lyric line$/],
    [["--lyrics", "huge.txt", "--out", "out"], /^lyrics file is over 64 KB$/],
    [["--lyrics", "lyrics.txt", "--out", "taken"], /^--out is not a folder$/],
  ];
  for (const [args, pattern] of cases) {
    const result = score(dir, args);
    assert.equal(result.status, 2, `${JSON.stringify(args)}: ${result.stdout}${result.stderr}`);
    assert.equal(lines(result.stdout).length, 1, JSON.stringify(result.stdout));
    assert.match(lines(result.stdout)[0], pattern);
    assert.equal(result.stderr, "");
  }
  assert.deepEqual(readdirSync(dir).sort(), ["cues.txt", "huge.txt", "lyrics.txt", "taken"]);
});

test("a Python side that fails exits 1, one short line on stderr, no report", () => {
  const dir = sheet();
  // `false` stands in for an interpreter that crashes: it exits 1 and prints nothing.
  const result = score(dir, ["--lyrics", "lyrics.txt", "--out", "out"], { FILM_PYTHON: "false" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(lines(result.stderr), ["film:score: python film_py.score failed"]);
  assert.equal(existsSync(join(dir, "out", "score-report.json")), false);

  const missing = score(dir, ["--lyrics", "lyrics.txt", "--out", "out"], { FILM_PYTHON: "studio-kit-no-such-python" });
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, "");
  assert.deepEqual(lines(missing.stderr), ["film:score: studio-kit-no-such-python could not be started"]);
});

test("a traceback from Python never reaches stdout", () => {
  const dir = sheet();
  // A module that does not exist makes the real interpreter print its error to stderr and
  // exit 1, as a crash with a traceback would: the caller gets the kit's own words only.
  const result = spawnSync(
    process.execPath,
    [
      "--import", "tsx", "--input-type=module", "-e",
      'const { python } = await import("./src/film/lib/cli.ts"); try { await python("no_such_module", [], 60000); } catch (e) { console.error(e.constructor.name + ": " + e.message); process.exit(1); }',
    ],
    { cwd: kitRoot, encoding: "utf8", env: { ...process.env, INIT_CWD: dir } },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(lines(result.stderr), ["Unexpected: python film_py.no_such_module failed"]);
});

test("the npm script runs it as the sandbox calls it: npm --prefix <kit> run film:score, from the caller's folder", () => {
  const dir = sheet();
  const env = { ...process.env };
  delete env.INIT_CWD;
  const result = spawnSync("npm", ["--prefix", kitRoot, "run", "--silent", "film:score", "--", "--lyrics", "lyrics.txt", "--out", "out"], {
    cwd: dir,
    encoding: "utf8",
    env,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(existsSync(join(dir, "out", "score-report.json")));
});
