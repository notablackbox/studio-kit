import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const kitRoot = resolve(import.meta.dirname, "..");

function run(entry: string) {
  const dir = mkdtempSync(join(tmpdir(), "studio-kit-changelog-"));
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
});

test("missing flags exit 2", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/changelog.ts"], {
    cwd: kitRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
});
