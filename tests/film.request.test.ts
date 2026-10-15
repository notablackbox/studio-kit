import { before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, kitRoot, lines } from "./fixtures/film.ts";
import { boardDir } from "./fixtures/board.ts";

// film:request shapes the input of the harness's call_external tool for one clip or image slot:
// the secret's name, the provider's URL, the body with {{artifact:<id>}} placeholders, the
// estimate, the idempotency key (provider, model, body and the attempt the ledger holds) and
// where the result goes. It never calls anything. The bodies are compared with recorded ones.

const requests = join(kitRoot, "tests", "fixtures", "requests");
let dir = "";
before(() => {
  dir = boardDir();
  cpSync(join(requests, "M01.json"), join(dir, "clips", "M01.json"));
  cpSync(join(requests, "P001.json"), join(dir, "P001.json"));
});

// The test's own canonical JSON and key, written apart from the kit's.
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}
const keyOf = (provider: string, model: string, body: unknown, attempt: number) =>
  createHash("sha256").update(canon({ attempt, body, model, provider })).digest("hex");

const golden = (name: string) => JSON.parse(readFileSync(join(requests, name), "utf8"));
const readJson = (...parts: string[]) => JSON.parse(readFileSync(join(dir, ...parts), "utf8"));
const normal = (request: Record<string, unknown>) => ({ ...request, idempotency_key: "<key>" });

const W01 = (provider: string, out: string, ledger = "ledger.jsonl", extra: string[] = []) => [
  "--clip", "clips/W01.json", "--provider", provider, "--ledger", ledger, "--out", out,
  "--start-artifact", "art-p-street", "--window-artifact", provider === "openrouter" ? "art-W01-wav" : "art-W01-mp3", ...extra,
];

test("a sung window on OpenRouter: reference mode, the recorded body, the key, the estimate", () => {
  const result = film("request", dir, W01("openrouter", "or"));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  const request = readJson("or", "W01.request.json");
  assert.deepEqual(normal(request), golden("W01.openrouter.request.json"));
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
  assert.deepEqual(report.outputs, { request: "W01.request.json", report: "request-report.json" });
  assert.equal(report.key, request.idempotency_key);
  assert.equal(report.estimate, 1.16);
  assert.equal(report.attempt, 1);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(lines(result.stdout), [
    `request: "W01" sung on openrouter, attempt 1, 5 s at 720p, estimate $1.16, key ${request.idempotency_key.slice(0, 12)}`,
  ]);
  assert.deepEqual(readdirSync(join(dir, "or")).sort(), ["W01.request.json", "request-report.json"]);
  // Nothing was written beside the ledger: film:request only reads it.
  assert.equal(existsSync(join(dir, "ledger.jsonl")), false);
});

test("the same sung window on Higgsfield, and a motion clip on both providers", () => {
  const hf = film("request", dir, W01("higgsfield", "hf"));
  assert.equal(hf.status, 0, hf.stdout + hf.stderr);
  const request = readJson("hf", "W01.request.json");
  assert.deepEqual(normal(request), golden("W01.higgsfield.request.json"));
  assert.equal(request.idempotency_key, keyOf("higgsfield", "bytedance/seedance-2.5", request.body, 1));

  for (const provider of ["openrouter", "higgsfield"]) {
    const result = film("request", dir, ["--clip", "clips/M01.json", "--provider", provider, "--ledger", "ledger.jsonl", "--out", `m-${provider}`, "--start-artifact", "art-p-roof"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const motion = readJson(`m-${provider}`, "M01.request.json");
    assert.deepEqual(normal(motion), golden(`M01.${provider}.request.json`));
    assert.equal(motion.idempotency_key, keyOf(provider, "bytedance/seedance-2.5", motion.body, 1));
  }
});

test("an image slot on OpenRouter: the image model through chat completions, no poll", () => {
  const result = film("request", dir, ["--image", "P001.json", "--provider", "openrouter", "--ledger", "ledger.jsonl", "--out", "img"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const request = readJson("img", "P001.request.json");
  assert.deepEqual(normal(request), golden("P001.openrouter.request.json"));
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
  assert.equal(second.kit.attempt, 2);
  assert.equal(second.fetch_to, "clips/W01/take-2.mp4");
  assert.notEqual(second.idempotency_key, first.idempotency_key);
  assert.equal(second.idempotency_key, keyOf("openrouter", "bytedance/seedance-2.5", second.body, 2));
  // A failed attempt still counts: the attempt after it is 3.
  assert.equal(film("ledger", dir, ["--ledger", "keys.jsonl", "--out", ".", "--asked", "k3/W01.request.json"]).status, 0);
  assert.equal(film("ledger", dir, ["--ledger", "keys.jsonl", "--out", ".", "--failed", second.idempotency_key, "--reason", "HTTP 502"]).status, 0);
  assert.equal(film("request", dir, W01("higgsfield", "k4", "keys.jsonl")).status, 0);
  assert.equal(readJson("k4", "W01.request.json").kit.attempt, 3);
  assert.equal(readJson("k4", "W01.request.json").fetch_to, "clips/W01/take-3.mp4");
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

test("the prompt rules and the clip's fields are refusals: one line each, exit 2, nothing written", () => {
  const long = Array.from({ length: 48 }, (_, i) => `beat${i}`).join(" ");
  const cases: [string[], string[]][] = [
    [["--clip", variant("X1", (c) => (c.window.t1 = c.window.t0 + 3.5))], ['"X1" window is 3.50 s (0.98 to 4.48), want 4 to 8 s']],
    [["--clip", variant("X2", (c) => (c.window.t1 = c.window.t0 + 8.5))], ['"X2" window is 8.50 s (0.98 to 9.48), want 4 to 8 s']],
    [["--clip", variant("X3", (c) => (c.body.prompt = long))], ['"X3" sung prompt is 120 words, want 110 or fewer']],
    [["--clip", variant("X4", (c) => (c.words = "{the city wakes}"))], ['"X4" words have braces: the lyric goes in plain quotes']],
    [["--clip", variant("X5", (c) => (c.body.prompt = 'she sings {"the city wakes"} to the lens'))], ['"X5" prompt has braces: the lyric goes in plain quotes']],
    [["--clip", variant("X6", (c) => (c.body.prompt = "close-up in 720p, 16:9, a 5 second clip"))], ['"X6" prompt has output settings ("720p", "16:9", "5 second clip"): they go in the request, never the prompt']],
    [["--clip", variant("X7", (c) => (c.body.prompt = "close-up, duration five, cinematic"))], ['"X7" prompt has output settings ("duration"): they go in the request, never the prompt']],
    [["--clip", variant("X8", (c) => delete c.body.prompt)], ['"X8" has no body.prompt']],
    [["--clip", variant("X9", (c) => { delete c.start; delete c.window; })], ['"X9" has no start', '"X9" has no window']],
    [["--clip", variant("X10", (c) => delete c.body.duration)], ['"X10" has no body.duration']],
    [["--clip", variant("X11", (c) => (c.words = ""))], ['"X11" has no words']],
    [["--clip", variant("X12", (c) => (c.kind = "dance"))], ['"X12" kind is "dance", want sung or motion']],
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

test("a sung prompt over about 90 words is a warning, not a refusal", () => {
  const words = Array.from({ length: 23 }, (_, i) => `w${i}`).join(" ");
  const clip = variant("X20", (c) => (c.body.prompt = `close-up ${words}`));
  const result = film("request", dir, ["--clip", clip, "--provider", "openrouter", "--ledger", "ledger.jsonl", "--out", "warn", "--start-artifact", "a1", "--window-artifact", "a2"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = readJson("warn", "request-report.json");
  assert.deepEqual(report.warnings, ['"X20" sung prompt is 96 words: a sung window copies best at about 90 or fewer']);
  assert.equal(lines(result.stdout)[1], 'warning: "X20" sung prompt is 96 words: a sung window copies best at about 90 or fewer');
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
