import { before, test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, lines } from "./fixtures/film.ts";
import { boardDir } from "./fixtures/board.ts";
import { keyOf, requestsFixture as requests } from "./fixtures/requests.ts";

// film:request shapes the input of the harness's call_external tool for one clip or image slot,
// exactly as spec 8.2 has it: the secret's name, the provider's URL, the method, the body with
// {{artifact:<id>}} placeholders, the estimate, the idempotency key (provider, model, body and
// the attempt the ledger holds) and `return` (an asynchronous video job) or `fetch_to` (an
// image). Everything kit-side goes in <id>.request.meta.json: the reference, the attempt, the
// rates, the poll and the download. It never calls anything. Both files are compared with
// recorded ones.

let dir = "";
before(() => {
  dir = boardDir();
  cpSync(join(requests, "M01.json"), join(dir, "clips", "M01.json"));
  cpSync(join(requests, "P001.json"), join(dir, "P001.json"));
});

const golden = (name: string) => JSON.parse(readFileSync(join(requests, name), "utf8"));
const readJson = (...parts: string[]) => JSON.parse(readFileSync(join(dir, ...parts), "utf8"));
const normal = (request: Record<string, unknown>) => ({ ...request, idempotency_key: "<key>" });
// The request and its meta file, each compared with its golden; the meta holds the same key.
function matches(out: string, id: string, goldenName: string) {
  const request = readJson(out, `${id}.request.json`);
  const meta = readJson(out, `${id}.request.meta.json`);
  assert.deepEqual(normal(request), golden(`${goldenName}.request.json`));
  assert.deepEqual(normal(meta), golden(`${goldenName}.request.meta.json`));
  assert.equal(meta.idempotency_key, request.idempotency_key);
  return { request, meta };
}
// Exactly call_external's input fields, nothing of the kit's.
const INPUT = (result: "return" | "fetch_to") => ["secret", "url", "method", "body", "estimate", "idempotency_key", result];

const W01 = (provider: string, out: string, ledger = "ledger.jsonl", extra: string[] = []) => [
  "--clip", "clips/W01.json", "--provider", provider, "--ledger", ledger, "--out", out,
  "--start-artifact", "art-p-street", "--window-artifact", provider === "openrouter" ? "art-W01-wav" : "art-W01-mp3", ...extra,
];

test("a sung window on OpenRouter: reference mode, the recorded body, the key, the estimate", () => {
  const result = film("request", dir, W01("openrouter", "or"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const { request, meta } = matches("or", "W01", "W01.openrouter");
  assert.deepEqual(Object.keys(request), INPUT("return"));
  assert.equal(request.return, true);
  // Submit, poll, download: the poll is a GET with no body; the download applies fetch_to to
  // the result URL the poll returns.
  assert.deepEqual(meta.poll, { method: "GET", url: "https://openrouter.ai/api/v1/videos/{id}", body: null });
  assert.deepEqual(meta.download, { from: "unsigned_urls[0]", fetch_to: "clips/W01/take-1.mp4" });
  assert.equal(request.idempotency_key, keyOf("openrouter", "bytedance/seedance-2.5", request.body, 1));
  // The lyric in plain quotes, no braces, no output settings in the prompt.
  assert.match(request.body.prompt, /"the city wakes we count the windows"/);
  assert.doesNotMatch(request.body.prompt, /[{}]|720p|16:9/);
  // Reference mode: no first frame on OpenRouter, or the audio would be dropped.
  assert.equal(request.body.frame_images, undefined);
  const report = readJson("or", "request-report.json");
  assert.equal(report.ok, true);
  assert.deepEqual(report.inputs, {
    clip: join(dir, "clips", "W01.json"), image: null, provider: "openrouter", ledger: join(dir, "ledger.jsonl"),
    start_artifact: "art-p-street", window_artifact: "art-W01-wav", rate_per_second: null, rate_per_image: null, resolution: null,
  });
  assert.deepEqual(report.outputs, { request: "W01.request.json", meta: "W01.request.meta.json", report: "request-report.json" });
  assert.equal(report.key, request.idempotency_key);
  assert.equal(report.estimate, 1.16);
  assert.equal(report.attempt, 1);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(lines(result.stdout), [
    `request: "W01" sung on openrouter, attempt 1, 5 s at 720p, estimate $1.16, key ${request.idempotency_key.slice(0, 12)}`,
  ]);
  assert.deepEqual(readdirSync(join(dir, "or")).sort(), ["W01.request.json", "W01.request.meta.json", "request-report.json"]);
  // Nothing was written beside the ledger: film:request only reads it.
  assert.equal(existsSync(join(dir, "ledger.jsonl")), false);
});

test("the same sung window on Higgsfield, and a motion clip on both providers", () => {
  const hf = film("request", dir, W01("higgsfield", "hf"));
  assert.equal(hf.status, 0, hf.stdout + hf.stderr);
  const { request } = matches("hf", "W01", "W01.higgsfield");
  assert.equal(request.idempotency_key, keyOf("higgsfield", "bytedance/seedance-2.5", request.body, 1));

  for (const provider of ["openrouter", "higgsfield"]) {
    const result = film("request", dir, ["--clip", "clips/M01.json", "--provider", provider, "--ledger", "ledger.jsonl", "--out", `m-${provider}`, "--start-artifact", "art-p-roof"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const { request: motion } = matches(`m-${provider}`, "M01", `M01.${provider}`);
    assert.deepEqual(Object.keys(motion), INPUT("return"));
    assert.equal(motion.idempotency_key, keyOf(provider, "bytedance/seedance-2.5", motion.body, 1));
  }
});

test("an image slot on OpenRouter: the image model through chat completions, no poll", () => {
  const result = film("request", dir, ["--image", "P001.json", "--provider", "openrouter", "--ledger", "ledger.jsonl", "--out", "img"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const { request, meta } = matches("img", "P001", "P001.openrouter");
  // Synchronous: the POST's response body is streamed to fetch_to; nothing to poll.
  assert.deepEqual(Object.keys(request), INPUT("fetch_to"));
  assert.equal(request.fetch_to, "plates/cands/P001/1.json");
  assert.equal(meta.poll, null);
  assert.equal(request.idempotency_key, keyOf("openrouter", "google/gemini-3-pro-image", request.body, 1));
  assert.deepEqual(lines(result.stdout), [`request: "P001" image on openrouter, attempt 1, estimate $0.14, key ${request.idempotency_key.slice(0, 12)}`]);
  const over = film("request", dir, ["--image", "P001.json", "--provider", "openrouter", "--ledger", "ledger.jsonl", "--out", "img2", "--rate-per-image", "0.5"]);
  assert.equal(over.status, 0, over.stdout + over.stderr);
  assert.equal(readJson("img2", "P001.request.json").estimate, 0.5);
});

test("the key is deterministic; a new attempt in the ledger gives a new key and a new take path", () => {
  const once = film("request", dir, W01("openrouter", "k1", "keys.jsonl"));
  const twice = film("request", dir, W01("openrouter", "k2", "keys.jsonl"));
  assert.equal(once.status, 0, once.stdout + once.stderr);
  assert.equal(twice.status, 0);
  const first = readJson("k1", "W01.request.json");
  assert.equal(readJson("k2", "W01.request.json").idempotency_key, first.idempotency_key);

  // The request is asked: the ledger now holds attempt 1, so the next request is attempt 2.
  const asked = film("ledger", dir, ["--ledger", "keys.jsonl", "--out", ".", "--asked", "k1/W01.request.json"]);
  assert.equal(asked.status, 0, asked.stdout + asked.stderr);
  const next = film("request", dir, W01("openrouter", "k3", "keys.jsonl"));
  assert.equal(next.status, 0, next.stdout + next.stderr);
  const second = readJson("k3", "W01.request.json");
  assert.deepEqual(second.body, first.body);
  const secondMeta = readJson("k3", "W01.request.meta.json");
  assert.equal(secondMeta.attempt, 2);
  assert.equal(secondMeta.download.fetch_to, "clips/W01/take-2.mp4");
  assert.notEqual(second.idempotency_key, first.idempotency_key);
  assert.equal(second.idempotency_key, keyOf("openrouter", "bytedance/seedance-2.5", second.body, 2));
  // A failed attempt still counts: the attempt after it is 3.
  assert.equal(film("ledger", dir, ["--ledger", "keys.jsonl", "--out", ".", "--asked", "k3/W01.request.json"]).status, 0);
  assert.equal(film("ledger", dir, ["--ledger", "keys.jsonl", "--out", ".", "--failed", second.idempotency_key, "--reason", "HTTP 502"]).status, 0);
  assert.equal(film("request", dir, W01("higgsfield", "k4", "keys.jsonl")).status, 0);
  assert.equal(readJson("k4", "W01.request.meta.json").attempt, 3);
  assert.equal(readJson("k4", "W01.request.meta.json").download.fetch_to, "clips/W01/take-3.mp4");
});

test("--resolution and --rate-per-second change the body, the estimate and the key", () => {
  const result = film("request", dir, W01("openrouter", "r1", "ledger.jsonl", ["--resolution", "480p"]));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const request = readJson("r1", "W01.request.json");
  assert.equal(request.body.resolution, "480p");
  assert.equal(request.estimate, 0.52); // 5 s at 0.103
  assert.equal(request.idempotency_key, keyOf("openrouter", "bytedance/seedance-2.5", request.body, 1));
  const rate = film("request", dir, W01("higgsfield", "r2", "ledger.jsonl", ["--resolution", "1080p", "--rate-per-second", "1.25"]));
  assert.equal(rate.status, 0, rate.stdout + rate.stderr);
  assert.equal(readJson("r2", "W01.request.json").estimate, 6.25);
  assert.equal(readJson("r2", "request-report.json").inputs.rate_per_second, 1.25);
});

test("a reference the ledger marks declined is refused on every provider", () => {
  assert.equal(film("request", dir, W01("openrouter", "d1", "declined.jsonl")).status, 0);
  assert.equal(film("ledger", dir, ["--ledger", "declined.jsonl", "--out", ".", "--asked", "d1/W01.request.json"]).status, 0);
  const key = readJson("d1", "W01.request.json").idempotency_key;
  assert.equal(film("ledger", dir, ["--ledger", "declined.jsonl", "--out", ".", "--declined", key, "--reason", "face filter"]).status, 0);
  for (const provider of ["openrouter", "higgsfield"]) {
    const result = film("request", dir, W01(provider, "d2", "declined.jsonl"));
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.deepEqual(lines(result.stdout), ['"W01" was declined on openrouter: no request for it on any provider']);
    assert.equal(existsSync(join(dir, "d2")), false);
  }
  // Another reference is untouched.
  assert.equal(film("request", dir, ["--clip", "clips/M01.json", "--provider", "openrouter", "--ledger", "declined.jsonl", "--out", "d3", "--start-artifact", "art-p-roof"]).status, 0);
});

// A copy of W01 changed by `change`, written as clips/<id>.json.
function variant(id: string, change: (clip: Record<string, any>) => void): string {
  const clip = readJson("clips", "W01.json");
  clip.id = id;
  change(clip);
  writeFileSync(join(dir, "clips", `${id}.json`), JSON.stringify(clip));
  return `clips/${id}.json`;
}
// The same, changed as JSON text: for values JSON.stringify cannot write (1e309).
function rawVariant(id: string, change: (text: string) => string): string {
  const clip = readJson("clips", "W01.json");
  clip.id = id;
  const text = change(JSON.stringify(clip));
  assert.notEqual(text, JSON.stringify(clip));
  writeFileSync(join(dir, "clips", `${id}.json`), text);
  return `clips/${id}.json`;
}
// An image slot P001 with a change, in its own folder (the file is named by its id).
function slotVariant(folder: string, change: (slot: Record<string, any>) => void): string {
  const slot = readJson("P001.json");
  change(slot);
  mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, folder, "P001.json"), JSON.stringify(slot));
  return `${folder}/P001.json`;
}

test("the prompt rules and the clip's fields are refusals: one line each, exit 2, nothing written", () => {
  const long = Array.from({ length: 48 }, (_, i) => `beat${i}`).join(" ");
  const cases: [string[], string[]][] = [
    [["--clip", variant("X1", (c) => (c.window.t1 = c.window.t0 + 3.5))], ['"X1" window is 3.50 s (0.98 to 4.48), want 4 to 8 s']],
    [["--clip", variant("X2", (c) => (c.window.t1 = c.window.t0 + 8.5))], ['"X2" window is 8.50 s (0.98 to 9.48), want 4 to 8 s']],
    [["--clip", variant("X3", (c) => (c.body.prompt = long))], ['"X3" sung prompt is 120 words, want 110 or fewer']],
    [["--clip", variant("X4", (c) => (c.words = "{the city wakes}"))], ['"X4" words have braces: the lyric goes in plain quotes']],
    [["--clip", variant("X13", (c) => (c.words = 'the city "wakes"'))], ['"X13" words have a double quote: the kit quotes the lyric']],
    [["--clip", variant("X5", (c) => (c.body.prompt = 'she sings {"the city wakes"} to the lens'))], ['"X5" prompt has braces: the lyric goes in plain quotes']],
    [["--clip", variant("X6", (c) => (c.body.prompt = "close-up in 720p, 16:9, a 5 second clip"))], ['"X6" prompt has output settings ("720p", "16:9", "5 second clip"): they go in the request, never the prompt']],
    [["--clip", variant("X7", (c) => (c.body.prompt = "close-up, duration five, cinematic"))], ['"X7" prompt has output settings ("duration"): they go in the request, never the prompt']],
    [["--clip", variant("X8", (c) => delete c.body.prompt)], ['"X8" has no body.prompt']],
    [["--clip", variant("X9", (c) => { delete c.start; delete c.window; })], ['"X9" has no start', '"X9" has no window']],
    [["--clip", variant("X10", (c) => delete c.body.duration)], ['"X10" has no body.duration']],
    [["--clip", variant("X11", (c) => (c.words = ""))], ['"X11" has no words']],
    [["--clip", variant("X12", (c) => (c.kind = "dance"))], ['"X12" kind is "dance", want sung or motion']],
    // A duration must be finite: 1e309 parses as Infinity, and so does the string "Infinity".
    [["--clip", rawVariant("X14", (text) => text.replace('"duration":5', '"duration":1e309'))], ['"X14" body.duration is Infinity, want seconds above 0']],
    [["--clip", variant("X15", (c) => (c.body.duration = "Infinity"))], ['"X15" body.duration is "Infinity", want seconds above 0']],
    [["--clip", variant("X16", (c) => (c.body.duration = 0))], ['"X16" body.duration is 0, want seconds above 0']],
    [["--clip", rawVariant("X17", (text) => text.replace(/"t1":[0-9.]+/, '"t1":1e309'))], ['"X17" has no window']],
  ];
  for (const [flags, want] of cases) {
    const result = film("request", dir, ["--provider", "openrouter", "--ledger", "ledger.jsonl", "--out", "x", "--start-artifact", "a1", "--window-artifact", "a2", ...flags]);
    assert.equal(result.status, 2, `${flags.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(lines(result.stdout), want, flags.join(" "));
    assert.equal(existsSync(join(dir, "x")), false);
  }
});

test("flag refusals: one line each, exit 2, nothing written", () => {
  writeFileSync(join(dir, "bad.jsonl"), '{"kind": "asked"}\n');
  writeFileSync(join(dir, "notjson.json"), "nope");
  writeFileSync(join(dir, "afile"), "");
  const sung = ["--clip", "clips/W01.json", "--ledger", "ledger.jsonl", "--out", "x"];
  const arts = ["--start-artifact", "a1", "--window-artifact", "a2"];
  const cases: [string[], string][] = [
    [["--clip", "clips/W01.json"], "film:request: --clip <clip.json> or --image <slot.json>, --provider, --ledger and --out are required"],
    [[...sung, "--image", "P001.json", "--provider", "openrouter", ...arts], "film:request: give --clip or --image, not both"],
    [[...sung, "--provider", "fal", ...arts], '--provider "fal" has no known URL (openrouter or higgsfield)'],
    [["--image", "P001.json", "--ledger", "ledger.jsonl", "--out", "x", "--provider", "higgsfield"], '"P001" model "google/gemini-3-pro-image" has no known URL on higgsfield'],
    [[...sung, "--provider", "openrouter", "--start-artifact", "a1"], '"W01" is sung: --window-artifact is required'],
    [[...sung, "--provider", "openrouter", "--window-artifact", "a2"], "--start-artifact is required for a clip"],
    [[...sung, "--provider", "openrouter", "--start-artifact", "a}}b", "--window-artifact", "a2"], "--start-artifact wants an artifact id (letters, digits, . _ : -)"],
    [["--clip", "clips/M01.json", "--ledger", "ledger.jsonl", "--out", "x", "--provider", "openrouter", ...arts], '"M01" is a motion clip: it takes no --window-artifact'],
    [["--image", "P001.json", "--ledger", "ledger.jsonl", "--out", "x", "--provider", "openrouter", "--start-artifact", "a1"], "--image takes no --start-artifact or --window-artifact"],
    [[...sung, "--provider", "openrouter", ...arts, "--resolution", "4k"], '--resolution is "4k", want 480p, 720p or 1080p'],
    [[...sung, "--provider", "openrouter", ...arts, "--rate-per-second", "0"], '--rate-per-second is "0", want dollars above 0'],
    // Digits enough to overflow to Infinity are not a rate.
    [[...sung, "--provider", "openrouter", ...arts, "--rate-per-second", `1${"0".repeat(400)}`], `--rate-per-second is "1${"0".repeat(400)}", want dollars above 0`],
    [["--image", "P001.json", "--ledger", "ledger.jsonl", "--out", "x", "--provider", "openrouter", "--rate-per-image", `9${"9".repeat(400)}.5`], `--rate-per-image is "9${"9".repeat(400)}.5", want dollars above 0`],
    // An image slot's refs is a list of artifact ids: a string is not one, nor is null.
    [["--image", slotVariant("refstr", (s) => (s.refs = "art-lead-front")), "--ledger", "ledger.jsonl", "--out", "x", "--provider", "openrouter"], '"P001" refs is "art-lead-front", want a list of artifact ids'],
    [["--image", slotVariant("refnull", (s) => (s.refs = null)), "--ledger", "ledger.jsonl", "--out", "x", "--provider", "openrouter"], '"P001" refs is null, want a list of artifact ids'],
    [["--image", slotVariant("refnum", (s) => (s.refs = ["art-a", 7])), "--ledger", "ledger.jsonl", "--out", "x", "--provider", "openrouter"], '"P001" refs want artifact ids (letters, digits, . _ : -)'],
    [[...sung, "--provider", "higgsfield", ...arts, "--resolution", "1080p"], "no rate for bytedance/seedance-2.5 on higgsfield at 1080p: give --rate-per-second"],
    [["--clip", "nope.json", "--ledger", "ledger.jsonl", "--out", "x", "--provider", "openrouter", ...arts], "--clip cannot be read"],
    [["--clip", "notjson.json", "--ledger", "ledger.jsonl", "--out", "x", "--provider", "openrouter", ...arts], "--clip is not a clip file"],
    [["--clip", "clips/W01.json", "--ledger", "bad.jsonl", "--out", "x", "--provider", "openrouter", ...arts], "--ledger line 1 is not a ledger row"],
    [["--clip", "clips/W01.json", "--ledger", "ledger.jsonl", "--out", "afile", "--provider", "openrouter", ...arts], "--out is not a folder"],
  ];
  for (const [flags, want] of cases) {
    const result = film("request", dir, flags);
    assert.equal(result.status, 2, `${flags.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(lines(result.stdout), [want], flags.join(" "));
    assert.equal(existsSync(join(dir, "x")), false);
  }
  // A clip file whose id is not its file name.
  cpSync(join(dir, "clips", "W01.json"), join(dir, "clips", "W09.json"));
  const named = film("request", dir, ["--clip", "clips/W09.json", "--ledger", "ledger.jsonl", "--out", "x", "--provider", "openrouter", ...arts]);
  assert.equal(named.status, 2);
  assert.deepEqual(lines(named.stdout), ['--clip: "W09.json" holds clip "W01"']);
});

test("a --ledger at the request's own output paths is refused before any write", () => {
  const arts = ["--start-artifact", "a1", "--window-artifact", "a2"];
  mkdirSync(join(dir, "lq"), { recursive: true });
  for (const named of ["W01.request.json", "W01.request.meta.json"]) {
    // An empty ledger (no rows yet) sitting where the request would write.
    writeFileSync(join(dir, "lq", named), "");
    const result = film("request", dir, ["--clip", "clips/W01.json", "--ledger", `lq/${named}`, "--out", "lq", "--provider", "openrouter", ...arts]);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.deepEqual(lines(result.stdout), [`--ledger is ${JSON.stringify(named)} in --out: the request would overwrite it`]);
    assert.equal(readFileSync(join(dir, "lq", named), "utf8"), "");
  }
  assert.deepEqual(readdirSync(join(dir, "lq")).sort(), ["W01.request.json", "W01.request.meta.json"]);
  // A ledger not made yet, at that path in an --out not made yet, is refused the same way.
  const fresh = film("request", dir, ["--clip", "clips/W01.json", "--ledger", "lq2/W01.request.meta.json", "--out", "lq2", "--provider", "openrouter", ...arts]);
  assert.equal(fresh.status, 2, fresh.stdout + fresh.stderr);
  assert.deepEqual(lines(fresh.stdout), ['--ledger is "W01.request.meta.json" in --out: the request would overwrite it']);
  assert.equal(existsSync(join(dir, "lq2")), false);
});

test("a sung prompt over about 90 words is a warning, not a refusal", () => {
  const words = Array.from({ length: 23 }, (_, i) => `w${i}`).join(" ");
  const clip = variant("X20", (c) => (c.body.prompt = `close-up ${words}`));
  const result = film("request", dir, ["--clip", clip, "--provider", "openrouter", "--ledger", "ledger.jsonl", "--out", "warn", "--start-artifact", "a1", "--window-artifact", "a2"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = readJson("warn", "request-report.json");
  assert.deepEqual(report.warnings, ['"X20" sung prompt is 96 words: a sung window copies best at about 90 or fewer']);
  assert.equal(lines(result.stdout)[1], 'warning: "X20" sung prompt is 96 words: a sung window copies best at about 90 or fewer');

  // More than two timed beats: the short sung form allows two.
  const beats = variant("X21", (c) => (c.body.prompt = "close-up; 0-1s: she looks up; at 1.5 s she smiles; 2-3s: she leans in"));
  const timed = film("request", dir, ["--clip", beats, "--provider", "openrouter", "--ledger", "ledger.jsonl", "--out", "warn2", "--start-artifact", "a1", "--window-artifact", "a2"]);
  assert.equal(timed.status, 0, timed.stdout + timed.stderr);
  assert.deepEqual(readJson("warn2", "request-report.json").warnings, ['"X21" sung prompt has 3 timed beats: a sung window copies best with two or fewer']);
  // Two are fine.
  const two = variant("X22", (c) => (c.body.prompt = "close-up; 0-1s: she looks up; 2-3s: she leans in"));
  assert.equal(film("request", dir, ["--clip", two, "--provider", "openrouter", "--ledger", "ledger.jsonl", "--out", "warn3", "--start-artifact", "a1", "--window-artifact", "a2"]).status, 0);
  assert.deepEqual(readJson("warn3", "request-report.json").warnings, []);
});

test("anything unexpected is exit 1 with one line on stderr", () => {
  // The request file's name is taken by a folder.
  mkdirSync(join(dir, "blocked", "W01.request.json"), { recursive: true });
  const result = film("request", dir, W01("openrouter", "blocked"));
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(lines(result.stderr), ["film:request: unexpected failure"]);
  assert.equal(existsSync(join(dir, "blocked", "request-report.json")), false);
});
