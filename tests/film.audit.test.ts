import { before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, lines, song } from "./fixtures/film.ts";
import { boardDir, changedBoard } from "./fixtures/board.ts";

// film:audit over the fixture board: the passing board, then one board (or one flag) per gate
// that fails it, the refusals of a malformed board, and the report.

const GATES = ["tile", "chapters", "cuts", "sections", "words", "graphics", "lead", "budget", "windows", "plates", "banned", "treatments", "todo", "genuine", "hook", "box"];

type Gate = { gate: string; status: string; shots: string[]; problems: string[] };
type AuditReport = { ok: boolean; inputs: Record<string, unknown>; outputs: Record<string, unknown>; gates: Gate[]; warnings: string[]; summary: Record<string, number>; board_sha256: string };

let dir = "";
before(() => {
  dir = boardDir();
});

const ANALYSIS = ["--beats", "analysis/beats.json", "--words", "analysis/words.json", "--hits", "analysis/hits.json", "--display", "analysis/display.txt"];
const FLAGS = ["--walk-report", "walk-report.json", "--hooks", "THE CITY WAKES|Hold the light", "--taboo", "glorbo,fox", "--motion-seconds", "20", "--motion-clips", "2"];

function audit(board: string, out: string, extra: string[] = [], flags = FLAGS, env: NodeJS.ProcessEnv = {}) {
  return film("audit", dir, ["--board", board, ...ANALYSIS, "--out", out, ...flags, ...extra], env);
}
const report = (out: string): AuditReport => JSON.parse(readFileSync(join(dir, out, "audit-report.json"), "utf8"));
const gate = (r: AuditReport, name: string) => r.gates.find((g) => g.gate === name) as Gate;

// A board (or flags) that fails exactly one gate: exit 3, one line, that gate failed with these
// shots, every other gate as on the passing board.
function failsOnly(name: string, board: string, out: string, shots: string[], extra: string[] = [], flags = FLAGS): string {
  const result = audit(board, out, extra, flags);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const printed = lines(result.stdout);
  assert.equal(printed.length, 1, result.stdout);
  assert.ok(printed[0].startsWith(`gate ${name}: `), printed[0]);
  const r = report(out);
  assert.equal(r.ok, false);
  assert.equal(gate(r, name).status, "fail");
  assert.deepEqual(gate(r, name).shots, shots);
  for (const g of r.gates) if (g.gate !== name) assert.notEqual(g.status, "fail", `${g.gate} failed too: ${g.problems}`);
  return printed[0];
}

test("the fixture board passes every gate: exit 0 and the report lists all sixteen", () => {
  const result = audit("shots.json", "pass");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.match(lines(result.stdout)[0], /^audit: 16 gates, all pass: 5 shots, 12\.00 s, lead 83\.6%, 2 clips \(8\.92 s\)$/);
  const r = report("pass");
  assert.equal(r.ok, true);
  assert.deepEqual(r.gates.map((g) => g.gate), GATES);
  for (const g of r.gates) assert.equal(g.status, "pass", `${g.gate}: ${g.problems}`);
  assert.equal(r.summary.shots, 5);
  assert.ok(Math.abs(r.summary.lead_share - 0.83625) <= 1e-4, String(r.summary.lead_share));
  assert.equal(r.summary.clips, 2);
  assert.equal(r.summary.clip_seconds, 8.918);
  assert.match(r.board_sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(r.inputs, {
    board: join(dir, "shots.json"),
    beats: join(dir, "analysis/beats.json"),
    words: join(dir, "analysis/words.json"),
    hits: join(dir, "analysis/hits.json"),
    display: join(dir, "analysis/display.txt"),
    walk_report: join(dir, "walk-report.json"),
    recordings: null,
    lead_share: 0.7,
    motion_seconds: 20,
    motion_clips: 2,
    taboo: ["glorbo", "fox"],
    hooks: ["THE CITY WAKES", "Hold the light"],
    defer: [],
  });
  assert.deepEqual(r.outputs, { report: "audit-report.json" });
  // Nothing else is written in --out.
  assert.deepEqual(readdirSync(join(dir, "pass")), ["audit-report.json"]);
});

test("the board passes against the analysis the listening commands make from the song", () => {
  const made = song();
  mkdirSync(join(made.dir, "stems"));
  renameSync(join(made.dir, "drums.wav"), join(made.dir, "stems", "drums.wav"));
  renameSync(join(made.dir, "vocals.wav"), join(made.dir, "stems", "vocals.wav"));
  const steps: [string, string[]][] = [
    ["beats", ["--drums", "stems/drums.wav", "--lyrics", "lyrics.txt", "--out", "an"]],
    ["words", ["--vocals", "stems/vocals.wav", "--lyrics", "lyrics.txt", "--out", "an"]],
    ["hits", ["--stems", "stems", "--mix", "song.wav", "--out", "an"]],
  ];
  for (const [name, args] of steps) {
    const step = film(name, made.dir, args);
    assert.equal(step.status, 0, `${name}: ${step.stdout}${step.stderr}`);
  }
  const result = film("audit", made.dir, [
    "--board", join(dir, "shots.json"), "--beats", "an/beats.json", "--words", "an/words.json", "--hits", "an/hits.json",
    "--display", "display.txt", "--out", "audit", ...FLAGS.map((f) => (f === "walk-report.json" ? join(dir, f) : f)),
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("tile: an overlap fails", () => {
  // Inside one chapter (ch02), so only the shots' tiling is wrong.
  const board = changedBoard(dir, "tile.json", (_b, shot) => {
    shot("s004").t1 = 11.372;
  });
  const line = failsOnly("tile", board, "tile", ["s004", "s005"]);
  assert.equal(line, 'gate tile: "s004" ends at 11.372 s, after "s005" starts at 10.883 s');
});

test("chapters: a gap or an overlap between chapters, a chapter short of the song, a shot across a chapter's edge fail", () => {
  // A gap of 0.038 s between the chapters; s004 then starts 0.038 s before its chapter.
  const gap = changedBoard(dir, "chapters.json", (b) => {
    b.chapters[1].t0 = 6.5;
  });
  assert.equal(
    failsOnly("chapters", gap, "chapters", ["s004"]),
    'gate chapters: a gap from 6.462 to 6.5 s between "ch01" and "ch02"; "s004" runs 6.462 to 10.883 s, outside chapter "ch02" (6.5 to 12 s)',
  );
  // Within 0.03 s, and on the same frame of the 24 fps grid (6.462 and 6.48 are both frame 156,
  // the first frame at or after the time), passes.
  const close = changedBoard(dir, "chapters2.json", (b) => {
    b.chapters[1].t0 = 6.48;
  });
  assert.equal(audit(close, "chapters2").status, 0);
  // Within 0.03 s but across a frame boundary (6.4583 s is frame 155): ch01 renders up to frame
  // 154 and ch02 from frame 156, so frame 155 is in neither; the other way round, in both.
  const dropped = changedBoard(dir, "chapters7.json", (b) => {
    b.chapters[0].t1 = 6.455;
  });
  assert.equal(failsOnly("chapters", dropped, "chapters7", []), 'gate chapters: "ch01" ends at 6.455 s (frame 155) and "ch02" starts at 6.462 s (frame 156): frame 155 is in neither');
  const twice = changedBoard(dir, "chapters8.json", (b) => {
    b.chapters[0].t1 = 6.47;
    b.chapters[1].t0 = 6.455;
  });
  assert.equal(failsOnly("chapters", twice, "chapters8", []), 'gate chapters: "ch01" ends at 6.47 s (frame 156) and "ch02" starts at 6.455 s (frame 155): frame 155 is in both');
  // The first chapter must hold frame 0: 0.02 s is within 0.03 s of 0 but starts on frame 1.
  const head = changedBoard(dir, "chapters9.json", (b) => {
    b.chapters[0].t0 = 0.02;
  });
  assert.equal(failsOnly("chapters", head, "chapters9", []), 'gate chapters: the first chapter "ch01" starts at 0.02 s (frame 1): frame 0 is in no chapter');
  // An overlap, and the last chapter ending before the song.
  const overlap = changedBoard(dir, "chapters3.json", (b) => {
    b.chapters[0].t1 = 6.954;
    b.chapters[1].t1 = 11.86;
  });
  assert.equal(
    failsOnly("chapters", overlap, "chapters3", ["s005"]),
    'gate chapters: "ch01" ends at 6.954 s, after "ch02" starts at 6.462 s; the last chapter "ch02" ends at 11.86 s, the song at 12 s; "s005" runs 10.883 to 12 s, outside chapter "ch02" (6.462 to 11.86 s)',
  );
  // The chapters tile, but their edge falls inside s003: the shot is mostly in ch02 and starts
  // before it.
  const across = changedBoard(dir, "chapters4.json", (b) => {
    b.chapters[0].t1 = 5.9;
    b.chapters[1].t0 = 5.9;
  });
  assert.equal(failsOnly("chapters", across, "chapters4", ["s003"]), 'gate chapters: "s003" runs 5.473 to 6.462 s, outside chapter "ch02" (5.9 to 12 s)');
  // A chapter that starts late, and no chapters at all.
  const late = changedBoard(dir, "chapters5.json", (b) => {
    b.chapters[0].t0 = 0.5;
  });
  assert.equal(failsOnly("chapters", late, "chapters5", ["s001"]), 'gate chapters: the first chapter "ch01" starts at 0.5 s, not 0; "s001" runs 0 to 0.976 s, outside chapter "ch01" (0.5 to 6.462 s)');
  const none = changedBoard(dir, "chapters6.json", (b) => {
    b.chapters = [];
  });
  assert.equal(failsOnly("chapters", none, "chapters6", []), "gate chapters: the board has no chapters");
});

test("tile: a gap, a late start and a short end fail", () => {
  const board = changedBoard(dir, "tile2.json", (b, shot) => {
    shot("s001").t0 = 0.007;
    shot("s005").t1 = 11.859;
    b.duration = 11.859;
  });
  const line = failsOnly("tile", board, "tile2", ["s001", "s005"]);
  assert.equal(line, 'gate tile: the first shot "s001" starts at 0.007 s, not 0; the last shot "s005" ends at 11.859 s, the song at 12 s; the board\'s duration is 11.859 s, the song\'s 12 s');
});

test("cuts: a cut off the beat fails; on a hit from hits.json or a declared hit it passes", () => {
  const off = changedBoard(dir, "cuts.json", (_b, shot) => {
    shot("s001").t1 = 0.9;
    shot("s002").t0 = 0.9;
  });
  const line = failsOnly("cuts", off, "cuts", ["s002"]);
  assert.equal(line, 'gate cuts: the cut at 0.900 s into "s002" is 0.100 s from the nearest beat');

  const declared = changedBoard(dir, "cuts2.json", (_b, shot) => {
    shot("s001").t1 = 0.9;
    shot("s002").t0 = 0.9;
    shot("s002").hit = 0.9;
  });
  assert.equal(audit(declared, "cuts2").status, 0);

  // The edge: 0.031 s off fails, 0.029 s passes (the chapters' edge moves with the cut).
  const edge = changedBoard(dir, "cuts3.json", (b, shot) => {
    b.chapters[0].t1 = 6.431;
    b.chapters[1].t0 = 6.431;
    shot("s003").t1 = 6.431;
    shot("s004").t0 = 6.431;
  });
  assert.equal(failsOnly("cuts", edge, "cuts3", ["s004"]), 'gate cuts: the cut at 6.431 s into "s004" is 0.031 s from the nearest beat');
  const inside = changedBoard(dir, "cuts4.json", (b, shot) => {
    b.chapters[0].t1 = 6.433;
    b.chapters[1].t0 = 6.433;
    shot("s003").t1 = 6.433;
    shot("s004").t0 = 6.433;
  });
  assert.equal(audit(inside, "cuts4").status, 0);
});

test("sections: a section the beat map does not have fails", () => {
  const board = changedBoard(dir, "sections.json", (_b, shot) => {
    shot("s005").section = "Bridge";
  });
  const line = failsOnly("sections", board, "sections", ["s005"]);
  assert.equal(line, 'gate sections: "s005" is in "Bridge", not a section of the beat map ("Verse", "Chorus")');
});

test("words: a sung word in a shot whose lines or type leave its line out fails", () => {
  const notListed = changedBoard(dir, "words.json", (_b, shot) => {
    shot("s002").lines = [0];
  });
  const line = failsOnly("words", notListed, "words", ["s002"]);
  assert.equal(line, 'gate words: "s002" has words 3 to 6 of line 1 and does not list the line');

  const notTyped = changedBoard(dir, "words2.json", (_b, shot) => {
    (shot("s004").type as unknown[]).shift();
  });
  const typed = failsOnly("words", notTyped, "words2", ["s004"]);
  assert.equal(typed, 'gate words: "s004" has words 7 to 8 of line 2 and types no text for it');

  // An entry with empty text draws its line's display line (as the chapter engine fills it):
  // it passes.
  const fromDisplay = changedBoard(dir, "words3.json", (_b, shot) => {
    (shot("s004").type as Record<string, unknown>[])[0].text = "";
    (shot("s002").type as Record<string, unknown>[])[1].text = "  ";
  });
  const passed = audit(fromDisplay, "words3");
  assert.equal(passed.status, 0, passed.stdout);
  assert.equal(gate(report("words3"), "words").status, "pass");

  // Empty text and no display line for its line: still no text. words.json puts word 11 on a
  // line 4 the display (four lines) does not have; s004 lists it and types it empty.
  const words = JSON.parse(readFileSync(join(dir, "analysis", "words.json"), "utf8"));
  words.words[11].line = 4;
  writeFileSync(join(dir, "words-line4.json"), JSON.stringify(words));
  const noDisplay = changedBoard(dir, "words4.json", (_b, shot) => {
    const s = shot("s004");
    s.lines = [2, 3, 4];
    (s.type as Record<string, unknown>[]).push({ line: 4, mode: "subtitle", text: "", placement: "lower third" });
    (s.devices as Record<string, unknown>[]).push({ kind: "label", anchor: { slot: "right" }, params: { text: "LIGHT" }, key: "W", line: 4 });
  });
  const result = film("audit", dir, ["--board", noDisplay, ...ANALYSIS.slice(0, 2), "--words", "words-line4.json", ...ANALYSIS.slice(4), "--out", "words4", ...FLAGS]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.deepEqual(lines(result.stdout), ['gate words: "s004" has word 11 of line 4 and types no text for it']);
  assert.deepEqual(gate(report("words4"), "words").shots, ["s004"]);
});

test("graphics: a lyric line with no explaining graphic fails", () => {
  const board = changedBoard(dir, "graphics.json", (_b, shot) => {
    (shot("s004").devices as unknown[]).pop();
  });
  const line = failsOnly("graphics", board, "graphics", ["s004"]);
  assert.equal(line, "gate graphics: line 3 has no explaining graphic");
});

test("lead: her share under --lead-share fails", () => {
  const line = failsOnly("lead", "shots.json", "lead", [], ["--lead-share", "0.9"]);
  assert.equal(line, "gate lead: she is on screen 83.6% of the song, want at least 90.0%");
  assert.equal(report("lead").inputs.lead_share, 0.9);
});

test("budget: clip seconds over --motion-seconds, or clips over --motion-clips, fail; no budget is skipped", () => {
  const seconds = failsOnly("budget", "shots.json", "budget", ["s002", "s004"], ["--motion-seconds", "8"]);
  assert.equal(seconds, "gate budget: the clips run 8.92 s, the budget is 8 s");
  const clips = failsOnly("budget", "shots.json", "budget2", ["s002", "s004"], ["--motion-clips", "1"]);
  assert.equal(clips, "gate budget: 2 clips, the budget is 1");

  const none = audit("shots.json", "budget3", [], FLAGS.slice(0, 6));
  assert.equal(none.status, 0, none.stdout);
  assert.equal(gate(report("budget3"), "budget").status, "skipped");
  assert.match(lines(none.stdout)[0], /^audit: 16 gates, all pass \(1 skipped\): /);
});

test("windows: a sung shot under 4 s, a sung shot starting in a word, a short motion clip fail", () => {
  const short = changedBoard(dir, "windows.json", (_b, shot) => {
    shot("s004").t1 = 9.904;
    shot("s005").t0 = 9.904;
  });
  const line = failsOnly("windows", short, "windows", ["s004"]);
  assert.equal(line, 'gate windows: sung "s004" runs 3.442 s, want 4 to 8 s');

  const inWord = changedBoard(dir, "windows2.json", (_b, shot) => {
    shot("s001").t1 = 1.0;
    shot("s002").t0 = 1.0;
  });
  const word = failsOnly("windows", inWord, "windows2", ["s002"]);
  assert.equal(word, 'gate windows: sung "s002" starts at 1.000 s inside word 0 "the", not in a word gap');

  const motion = changedBoard(dir, "windows3.json", (_b, shot) => {
    Object.assign(shot("s005"), { motion_tier: "motion", clip: "M01", treatment: null, plate: "p-dawn" });
  });
  const result = audit(motion, "windows3", [], FLAGS.slice(0, 6));
  assert.equal(result.status, 3);
  // s005 on p-dawn is not continuous with s001: the plates gate fails too, one line each.
  assert.deepEqual(lines(result.stdout), [
    'gate windows: motion "s005" runs 1.117 s, want 4 to 12 s',
    'gate plates: plate "p-dawn" is on "s001" and "s005", which are not one continuous moment',
  ]);
});

test("plates: one plate on two shots apart, or two clips from one plate, fail; consecutive shots may share", () => {
  const apart = changedBoard(dir, "plates.json", (_b, shot) => {
    shot("s005").plate = "p-street";
  });
  const line = failsOnly("plates", apart, "plates", ["s002", "s005"]);
  assert.equal(line, 'gate plates: plate "p-street" is on "s002" and "s005", which are not one continuous moment');

  const twoClips = changedBoard(dir, "plates2.json", (_b, shot) => {
    Object.assign(shot("s005"), { motion_tier: "motion", clip: "M01", treatment: null });
  });
  const result = audit(twoClips, "plates2", [], FLAGS.slice(0, 6));
  assert.equal(result.status, 3);
  assert.ok(lines(result.stdout).includes('gate plates: clips "W02" and "M01" start from one plate "p-roof"'), result.stdout);
});

test("banned: a --taboo word, as a whole word, in the action, prompt, type or notes fails", () => {
  const line = failsOnly("banned", "shots.json", "banned", ["s001"], ["--taboo", "glorbo,lamps"], FLAGS.slice(0, 6));
  assert.equal(line, 'gate banned: "s001" action has "lamps"');
  // Whole words only: "lamp" is not in "lamps".
  assert.equal(audit("shots.json", "banned2", ["--taboo", "lamp"], FLAGS.slice(0, 6)).status, 0);
  const typed = failsOnly("banned", "shots.json", "banned3", ["s001", "s002"], ["--taboo", "WAKES"], FLAGS.slice(0, 4));
  assert.equal(typed, 'gate banned: "s001" type has "WAKES"; "s002" type has "WAKES"');
  // Every string in the board counts: sets, prompts, the plates' and the chapters' fields.
  const prompt = failsOnly("banned", "shots.json", "banned4", ["s002"], ["--taboo", "doorway"], FLAGS.slice(0, 4));
  assert.equal(prompt, 'gate banned: "s002" set has "doorway"; "s002" prompt has "doorway"; plates[1].set has "doorway"; plates[1].prompt has "doorway"');
  const set = failsOnly("banned", "shots.json", "banned5", ["s002"], ["--taboo", "buzzer"], FLAGS.slice(0, 4));
  assert.equal(set, 'gate banned: "s002" set has "buzzer"');
  const chapter = failsOnly("banned", "shots.json", "banned6", [], ["--taboo", "wake"], FLAGS.slice(0, 4));
  assert.equal(chapter, 'gate banned: chapters[0].name has "wake"');
  // The words a device draws count.
  const device = failsOnly("banned", "shots.json", "banned7", ["s004"], ["--taboo", "lux"], FLAGS.slice(0, 4));
  assert.equal(device, 'gate banned: "s004" devices has "lux"');
  // Closed vocabularies and keys are not authored text: a framing, a transition, a type mode,
  // a device kind or key, a plate key, a clip id, a footage name or a shot id never trips it.
  const keys = audit("shots.json", "banned8", ["--taboo", "cu,ews,dither,masthead,counter,w,p-street,W01,shot-01,s001,plate3d,sung"], FLAGS.slice(0, 4));
  assert.equal(keys.status, 0, keys.stdout);
});

test("treatments: two 2.5D shots in a row with one treatment, or a 2.5D shot without one, fail", () => {
  const same = changedBoard(dir, "treat.json", (_b, shot) => {
    Object.assign(shot("s004"), { motion_tier: "plate3d", clip: null, treatment: "push" });
  });
  const line = failsOnly("treatments", same, "treat", ["s004", "s005"]);
  assert.equal(line, 'gate treatments: "s004" and "s005" both use "push"');

  const none = changedBoard(dir, "treat2.json", (_b, shot) => {
    shot("s005").treatment = null;
  });
  const missing = failsOnly("treatments", none, "treat2", ["s005"]);
  assert.equal(missing, 'gate treatments: "s005" is 2.5D with no treatment');
});

test("todo: a placeholder anywhere, or a shot without a framing, fails", () => {
  const board = changedBoard(dir, "todo.json", (b, shot) => {
    shot("s003").action = "TODO: the dashboard";
    shot("s001").framing = null;
    b.chapters[1].name = "TBD";
    shot("s002").camera = "???";
  });
  const line = failsOnly("todo", board, "todo", ["s001", "s002", "s003"]);
  assert.equal(line, 'gate todo: "s001" has no framing; "s002" camera has "???"; "s003" action has "TODO"; chapters[1].name has "TBD"');

  // Any case, whole words: "todo" is a placeholder, "mastodon" is not.
  const lower = changedBoard(dir, "todo2.json", (_b, shot) => {
    shot("s003").action = "todo: the dashboard";
    shot("s004").notes = "a mastodon on the water tank";
  });
  assert.equal(failsOnly("todo", lower, "todo2", ["s003"]), 'gate todo: "s003" action has "todo"');

  // In typed lyric text only capitals count: "todo" may be sung (Spanish).
  const lyric = changedBoard(dir, "todo3.json", (_b, shot) => {
    (shot("s001").type as Record<string, unknown>[])[0].text = "todo el mundo";
  });
  assert.equal(audit(lyric, "todo3", ["--hooks", "todo el mundo|hold the light"], FLAGS.slice(0, 2)).status, 0);
  const typed = changedBoard(dir, "todo4.json", (_b, shot) => {
    (shot("s004").type as Record<string, unknown>[])[0].text = "TODO";
  });
  assert.equal(failsOnly("todo", typed, "todo4", ["s004"], [], FLAGS.slice(0, 2)), 'gate todo: "s004" type[0].text has "TODO"');
});

test("genuine: footage not recorded fails; --recordings counts; --defer provenance defers", () => {
  const noFiles = failsOnly("genuine", "shots.json", "genuine", ["s003"], [], FLAGS.slice(2));
  assert.equal(noFiles, 'gate genuine: "s003" footage "shot-01.webm" is not in walk-report.json or recordings.json (none given)');

  const failedShot = changedBoard(dir, "genuine.json", (_b, shot) => {
    shot("s003").footage = "shot-02.webm";
  });
  const notRecorded = failsOnly("genuine", failedShot, "genuine2", ["s003"]);
  assert.equal(notRecorded, 'gate genuine: "s003" footage "shot-02.webm" is not in walk-report.json or recordings.json');

  const terminal = changedBoard(dir, "genuine3.json", (_b, shot) => {
    shot("s003").footage = "footage/terminal-01.mp4";
  });
  assert.equal(audit(terminal, "genuine3", ["--recordings", "recordings.json"]).status, 0);

  const nothing = changedBoard(dir, "genuine4.json", (_b, shot) => {
    shot("s003").footage = null;
  });
  const named = failsOnly("genuine", nothing, "genuine4", ["s003"]);
  assert.equal(named, 'gate genuine: "s003" is genuine and names no clip or footage');

  const deferred = audit("shots.json", "genuine5", ["--defer", "provenance"], FLAGS.slice(2));
  assert.equal(deferred.status, 0, deferred.stdout);
  assert.equal(gate(report("genuine5"), "genuine").status, "deferred");
  assert.deepEqual(gate(report("genuine5"), "genuine").shots, ["s003"]);
  assert.match(lines(deferred.stdout)[0], /^audit: 16 gates, all pass \(1 deferred\): /);
  assert.deepEqual(report("genuine5").inputs.defer, ["provenance"]);

  // --defer provenance never defers a genuine shot that names nothing.
  const unnamed = failsOnly("genuine", nothing, "genuine6", ["s003"], ["--defer", "provenance"], FLAGS.slice(2));
  assert.equal(unnamed, 'gate genuine: "s003" is genuine and names no clip or footage');

  // A clip id matches a recorded file's stem.
  const byClip = changedBoard(dir, "genuine7.json", (_b, shot) => {
    Object.assign(shot("s003"), { footage: null, clip: "shot-01" });
  });
  assert.equal(audit(byClip, "genuine7").status, 0);
  const notRecordedClip = changedBoard(dir, "genuine8.json", (_b, shot) => {
    Object.assign(shot("s003"), { footage: null, clip: "shot-02" });
  });
  assert.equal(failsOnly("genuine", notRecordedClip, "genuine8", ["s003"]), 'gate genuine: "s003" clip "shot-02" is not in walk-report.json or recordings.json');
});

test("hook: each --hooks entry must be a masthead or mass card somewhere", () => {
  const flags = [...FLAGS.slice(0, 2), ...FLAGS.slice(4)];
  const line = failsOnly("hook", "shots.json", "hook", [], ["--hooks", "THE CITY WAKES|NOT A FOX|We count the windows."], flags);
  assert.equal(line, 'gate hook: "NOT A FOX" is on no masthead or mass card; "We count the windows." is on no masthead or mass card');
  // Case, spacing and punctuation do not matter.
  assert.equal(audit("shots.json", "hook2", ["--hooks", "  the   city WAKES |hold, the LIGHT!"], flags).status, 0);
  // A hook in parts (" / ") is one card with the whole text, or a stack of its parts in order.
  const stacked = changedBoard(dir, "hook3.json", (_b, shot) => {
    (shot("s005").type as unknown[]).push({ line: null, mode: "stack", text: "NOT A CAT\nNOT IN A BOX." });
    (shot("s001").type as unknown[]).push({ line: null, mode: "mass", text: "Velocity. Is. The moat" });
  });
  assert.equal(audit(stacked, "hook3", ["--hooks", "not a cat / not in a box|VELOCITY IS THE MOAT"], flags).status, 0);
  const wrongOrder = failsOnly("hook", stacked, "hook4", [], ["--hooks", "NOT IN A BOX / NOT A CAT"], flags);
  assert.equal(wrongOrder, 'gate hook: "NOT IN A BOX / NOT A CAT" is on no masthead or mass card and no stack of its parts');
});

test("box: two chapters in a row in the same box fail", () => {
  const board = changedBoard(dir, "box.json", (b) => {
    b.chapters[1].box = " The Street";
  });
  const line = failsOnly("box", board, "box", []);
  assert.equal(line, 'gate box: "ch01" and "ch02" are both in the box "the street"');
});

test("several failing gates: one line each, in gate order, and the report has them all", () => {
  const board = changedBoard(dir, "many.json", (_b, shot) => {
    shot("s005").section = "Bridge";
    shot("s001").framing = null;
  });
  const result = audit(board, "many", ["--lead-share", "0.95"]);
  assert.equal(result.status, 3);
  assert.deepEqual(lines(result.stdout), [
    'gate sections: "s005" is in "Bridge", not a section of the beat map ("Verse", "Chorus")',
    "gate lead: she is on screen 83.6% of the song, want at least 95.0%",
    'gate todo: "s001" has no framing',
  ]);
  const r = report("many");
  assert.deepEqual(r.gates.filter((g) => g.status === "fail").map((g) => g.gate), ["sections", "lead", "todo"]);
});

test("warnings do not fail: her share over 85%, a plate no shot uses, the same transition twice", () => {
  const board = changedBoard(dir, "warn.json", (b, shot) => {
    shot("s001").lead_on_screen = true;
    shot("s004").transition_in = "dither";
    b.plates.push({ plate: "p-spare", prompt: "a spare plate", used_by: [] });
  });
  const result = audit(board, "warn");
  assert.equal(result.status, 0, result.stdout);
  const r = report("warn");
  assert.deepEqual(r.warnings, [
    "she is on screen 91.8% of the song, over 85%: leave room for inserts",
    '"s004" and "s005" both come in with "dither"',
    'plate "p-spare" is used by no shot',
  ]);
  assert.deepEqual(lines(result.stdout).slice(1), r.warnings.map((w) => `warning: ${w}`));
});

test("a malformed board is refused: exit 2, one line per problem, nothing written", () => {
  const cases: [(b: Record<string, unknown>, shots: Record<string, unknown>[]) => void, string[]][] = [
    [(b) => (b.title = "x"), ['--board: the board has an unknown field "title"']],
    [(_b, s) => (s[0].colour = "red"), ['--board: shots[0] has an unknown field "colour"']],
    [(_b, s) => (s[0].framing = "XCU"), ['--board: shots[0].framing is "XCU", want one of ECU, CU, MCU, MS, MWS, WS, FS, EWS, OTS']],
    [(_b, s) => (s[1].motion_tier = "video"), ['--board: shots[1].motion_tier is "video", want one of still, plate3d, motion, sung']],
    [(_b, s) => (s[1].t1 = 0.5), ["--board: shots[1] ends at 0.5, not after its start 0.976"]],
    [(_b, s) => (s[2].id = "s002"), ['--board: shots[2].id "s002" is used twice']],
    [(_b, s) => (s[2].id = "S3"), ['--board: shots[2].id is "S3", want s and three digits (s001)']],
    [(_b, s) => ((s[3].type as Record<string, unknown>[])[0].mode = "karaoke"), ['--board: shots[3].type[0].mode is "karaoke", want one of subtitle, coverline, masthead, stack, mass']],
    [(_b, s) => ((s[3].devices as Record<string, unknown>[])[0].kind = "clipart"), ['--board: shots[3].devices[0].kind is "clipart", want one of counter, label, terminal, chart, strike, spec-sheet']],
    [(_b, s) => (s[4].treatment = "zoom"), ['--board: shots[4].treatment is "zoom", want one of push, drift, parallax-left, parallax-right, rise, settle, or null']],
    [(_b, s) => (s[4].plate = "../p-roof"), ['--board: shots[4].plate is "../p-roof", want a key of letters, digits, dot, dash or underscore, or null']],
    [(b) => ((b.chapters as Record<string, unknown>[])[0].box = 7), ["--board: chapters[0].box is 7, want a short text (at most 60 characters)"]],
    [(b) => (b.version = 2), ["--board: version is 2, want 1"]],
  ];
  cases.forEach(([change, want], n) => {
    const board = changedBoard(dir, `bad${n}.json`, (b) => change(b as unknown as Record<string, unknown>, b.shots));
    const result = audit(board, "x");
    assert.equal(result.status, 2, `${n}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(lines(result.stdout), want, `case ${n}`);
    assert.equal(existsSync(join(dir, "x")), false);
  });
  writeFileSync(join(dir, "notjson.json"), "{");
  const result = audit("notjson.json", "x");
  assert.equal(result.status, 2);
  assert.deepEqual(lines(result.stdout), ["--board is not a JSON file"]);
});

test("refusals: one line each on stdout, exit 2, nothing written", () => {
  writeFileSync(join(dir, "afile"), "x");
  writeFileSync(join(dir, "short.txt"), "One line.\n");
  const cases: [string[], string][] = [
    [["--board", "shots.json", "--out", "x"], "film:audit: --board, --beats, --words, --hits, --display and --out are required"],
    [["--board", "shots.json", ...ANALYSIS.slice(0, 1), "analysis/words.json", ...ANALYSIS.slice(2), "--out", "x"], "--beats is not a beats.json"],
    [["--board", "shots.json", ...ANALYSIS.slice(0, 3), "analysis/beats.json", ...ANALYSIS.slice(4), "--out", "x"], "--words is not a words.json"],
    [["--board", "shots.json", ...ANALYSIS.slice(0, 5), "analysis/words.json", ...ANALYSIS.slice(6), "--out", "x"], "--hits is not a hits.json"],
    [["--board", "shots.json", ...ANALYSIS.slice(0, 7), "short.txt", "--out", "x"], "--display has 1 lyric line, words.json has 4"],
    [["--board", "nope.json", ...ANALYSIS, "--out", "x"], "--board cannot be read"],
    [["--board", "shots.json", ...ANALYSIS, "--out", "x", "--defer", "beats"], '--defer is "beats", want provenance'],
    [["--board", "shots.json", ...ANALYSIS, "--out", "x", "--lead-share", "1.5"], '--lead-share is "1.5", want a share from 0 to 1'],
    [["--board", "shots.json", ...ANALYSIS, "--out", "x", "--motion-seconds", "0"], '--motion-seconds is "0", want seconds above 0'],
    [["--board", "shots.json", ...ANALYSIS, "--out", "x", "--motion-clips", "2.5"], '--motion-clips is "2.5", want a whole number'],
    [["--board", "shots.json", ...ANALYSIS, "--out", "x", "--walk-report", "analysis/beats.json"], "--walk-report is not a walk-report.json"],
    [["--board", "shots.json", ...ANALYSIS, "--out", "x", "--recordings", "analysis/beats.json"], "--recordings is not a recordings.json"],
    [["--board", "shots.json", ...ANALYSIS, "--out", "afile"], "--out is not a folder"],
  ];
  for (const [args, line] of cases) {
    const result = film("audit", dir, args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(lines(result.stdout), [line], args.join(" "));
    assert.equal(existsSync(join(dir, "x")), false);
  }
});

test("anything unexpected is exit 1 with one line on stderr", () => {
  mkdirSync(join(dir, "y", "audit-report.json"), { recursive: true });
  const result = audit("shots.json", "y");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(lines(result.stderr), ["film:audit: unexpected failure"]);
});
