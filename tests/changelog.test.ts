import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const kitRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

// Every temp folder a test makes is removed once the file's tests are done.
const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "studio-kit-changelog-"));
  temps.push(dir);
  return dir;
}

function run(entry: string) {
  const dir = tempDir();
  const input = join(dir, "entry.md");
  const output = join(dir, "card.html");
  writeFileSync(input, entry);
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "src/changelog.ts", "--in", input, "--out", output],
    { cwd: kitRoot, encoding: "utf8", env: { ...process.env, INIT_CWD: dir } },
  );
  return { result, output, html: existsSync(output) ? readFileSync(output, "utf8") : null };
}

function countMatches(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

test("a dated entry becomes one article with the heading, two li and the closing p", () => {
  const { result, html } = run(
    [
      "## 13 October 2026",
      "- Runs now show their receipt",
      "- The Office opens faster",
      "That is what shipped today.",
      "",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(html);
  assert.equal(countMatches(html, /<article class="changelog-card">/g), 1);
  assert.equal(countMatches(html, /<\/article>/g), 1);
  assert.match(html, /<h2>13 October 2026<\/h2>/);
  assert.equal(countMatches(html, /<li>/g), 2);
  assert.match(html, /<li>Runs now show their receipt<\/li>/);
  assert.match(html, /<li>The Office opens faster<\/li>/);
  assert.match(html, /<p>That is what shipped today\.<\/p>/);
});

test("an ISO date in the heading is accepted", () => {
  const { result, html } = run("# 2026-10-13\n- One change\nClosing line.\n");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(html);
  assert.match(html, /<h2>2026-10-13<\/h2>/);
});

test("hostile lines arrive as escaped text and add no tags or attributes", () => {
  const { result, html } = run(
    [
      "## 2026-10-13",
      "- <script>alert(1)</script>",
      '- <img src="https://example.invalid/x.png" onerror="alert(1)">',
      "- ![pixel](https://example.invalid/p.png)",
      "- [PR 12](https://example.invalid/pull/12) & \"more\" 'quoted'",
      "Closing <b>line</b>.",
      "",
    ].join("\n"),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(html);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img src=&quot;https:\/\/example\.invalid\/x\.png&quot; onerror=&quot;alert\(1\)&quot;&gt;/);
  assert.match(html, /!\[pixel\]\(https:\/\/example\.invalid\/p\.png\)/);
  assert.match(html, /\[PR 12\]\(https:\/\/example\.invalid\/pull\/12\) &amp; &quot;more&quot; &#39;quoted&#39;/);

  const tags = new Set([...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase()));
  assert.deepEqual([...tags].sort(), ["article", "h2", "li", "p", "ul"]);

  const attributes = [...html.matchAll(/<[a-zA-Z][^>]*\s([a-zA-Z-]+)=/g)].map((m) => m[1]);
  assert.deepEqual(attributes, ["class"]);
  assert.doesNotMatch(html, /<(script|img)\b/i);
});

test("a first line with no date exits 2 and writes no file", () => {
  const { result, output, html } = run("## What shipped\n- One change\nClosing line.\n");
  assert.equal(result.status, 2);
  assert.equal(html, null);
  assert.equal(existsSync(output), false);
  // Refusal lines go to stdout, as walk and render print theirs.
  assert.deepEqual(result.stdout.split("\n").filter(Boolean), ["changelog: the first line holds no date"]);
  assert.equal(result.stderr, "");
});

test("every refusal is one line on stdout", () => {
  const dir = tempDir();
  const env = { ...process.env, INIT_CWD: dir };
  const cases: [string[], string][] = [
    [[], "changelog: --in <file.md> and --out <file.html> are both required"],
    [["--in", "entry.md"], "changelog: --in <file.md> and --out <file.html> are both required"],
    [["--in", "missing.md", "--out", "card.html"], "changelog: cannot read the --in file"],
  ];
  for (const [args, line] of cases) {
    const result = spawnSync(process.execPath, ["--import", "tsx", "src/changelog.ts", ...args], {
      cwd: kitRoot,
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.deepEqual(result.stdout.split("\n").filter(Boolean), [line]);
    assert.equal(result.stderr, "");
  }
  const unknown = spawnSync(process.execPath, ["--import", "tsx", "src/changelog.ts", "--nope\nforged"], {
    cwd: kitRoot,
    encoding: "utf8",
    env,
  });
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout.split("\n").filter(Boolean).length, 1, JSON.stringify(unknown.stdout));
});

test("importing changelog.ts runs nothing: no output, no exit code", () => {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", 'const m = await import("./src/changelog.ts"); if (typeof m.parseEntry !== "function") process.exit(9);'],
    { cwd: kitRoot, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("missing flags exit 2 and write nothing", () => {
  const dir = tempDir();
  const input = join(dir, "entry.md");
  writeFileSync(input, "## 2026-10-13\n- One change\nClosing line.\n");
  const bare = spawnSync(process.execPath, ["--import", "tsx", "src/changelog.ts"], {
    cwd: kitRoot,
    encoding: "utf8",
    env: { ...process.env, INIT_CWD: dir },
  });
  assert.equal(bare.status, 2);
  const noOut = spawnSync(process.execPath, ["--import", "tsx", "src/changelog.ts", "--in", input], {
    cwd: kitRoot,
    encoding: "utf8",
    env: { ...process.env, INIT_CWD: dir },
  });
  assert.equal(noOut.status, 2);
  assert.deepEqual(readdirSync(dir), ["entry.md"]);
});

for (const heading of ["## 2026-99-99", "## 31 February 2026", "## 29 February 2026"]) {
  test(`an impossible date (${heading.slice(3)}) exits 2 and writes no file`, () => {
    const { result, output, html } = run(`${heading}\n- One change\nClosing line.\n`);
    assert.equal(result.status, 2);
    assert.equal(html, null);
    assert.equal(existsSync(output), false);
  });
}

test("a real leap day writes a card", () => {
  const { result, html } = run("## 29 February 2028\n- One change\nClosing line.\n");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(html);
  assert.match(html, /<h2>29 February 2028<\/h2>/);
});

test("a leading dash or star marker is dropped from change lines and the closing line", () => {
  const { result, html } = run("## 2026-10-13\n- Dash change\n* Star change\n* Star closing.\n");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(html);
  assert.match(html, /<li>Dash change<\/li>/);
  assert.match(html, /<li>Star change<\/li>/);
  assert.match(html, /<p>Star closing\.<\/p>/);
  assert.doesNotMatch(html, /[-*] (Dash|Star)/);

  const dashClosing = run("## 2026-10-13\n* Star change\n- Dash closing.\n");
  assert.equal(dashClosing.result.status, 0, dashClosing.result.stderr);
  assert.ok(dashClosing.html);
  assert.match(dashClosing.html, /<p>Dash closing\.<\/p>/);
});
