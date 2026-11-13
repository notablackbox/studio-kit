import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { kitRoot } from "./fixtures/film.ts";

// The gate's arithmetic on 100 words, through film_py.words.gate itself: no models, no audio.
function gate(within: number, by: "expect" | "conf") {
  const timed = Array.from({ length: 100 }, (_, i) => ({ i, w: "la", t0: i, t1: i + 0.5, conf: by === "conf" && i >= within ? 0.1 : 0.9 }));
  const expect = by === "expect" ? timed.map((t) => (t.i < within ? [t.t0, t.t1] : [t.t0 + 1, t.t1 + 1])) : null;
  const code = "import json, sys; sys.path.insert(0, 'src/film/py'); from film_py.words import gate; print(json.dumps(gate(*json.loads(sys.argv[1]))))";
  const result = spawnSync("python3", ["-I", "-B", "-c", code, JSON.stringify([timed, expect])], { cwd: kitRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const [check, failures, warnings] = JSON.parse(result.stdout);
  return { check, failures, warnings };
}

test("the expected-times check stays strict: 89 of 100 fails, 90 and 91 pass", () => {
  const at89 = gate(89, "expect");
  assert.deepEqual([at89.check.ok, at89.check.verdict, at89.check.share], [false, "fail", 0.89]);
  assert.equal(at89.failures[0], "words: 89 of 100 within 0.10 s of the expected times, want at least 90 percent");
  assert.equal(at89.failures.length, 12, "the line, then each of the 11 words off");
  assert.deepEqual(at89.warnings, []);
  for (const within of [90, 91]) {
    const { check, failures, warnings } = gate(within, "expect");
    assert.deepEqual([check.by, check.within, check.of, check.ok, check.verdict], ["expect", within, 100, true, "pass"]);
    assert.deepEqual([failures, warnings], [[], []]);
  }
});

test("without --expect a low confidence share warns for review: 89 of 100 reviews, 90 and 91 pass", () => {
  const at89 = gate(89, "conf");
  assert.deepEqual([at89.check.by, at89.check.gate, at89.check.ok, at89.check.verdict, at89.check.share], ["conf", 0.5, false, "review", 0.89]);
  assert.deepEqual(at89.failures, [], "a review is not a failure");
  assert.deepEqual(at89.warnings, ["words: 89 of 100 with confidence 0.5 or more, under 90 percent: review this take before it is used"]);
  for (const within of [90, 91]) {
    const { check, failures, warnings } = gate(within, "conf");
    assert.deepEqual([check.within, check.ok, check.verdict], [within, true, "pass"]);
    assert.deepEqual([failures, warnings], [[], []]);
  }
});
