import { before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { film, lines } from "./fixtures/film.ts";
import { boardDir, changedBoard } from "./fixtures/board.ts";

// film:sheet: the board as a PDF of cards, twelve a page after a cover with the chapter map;
// the plate where it exists, a prompt card where it does not.

let dir = "";
before(() => {
  dir = boardDir();
});

// The pages of a PDF: its page objects (not the /Pages tree nodes).
const pageCount = (pdf: Buffer) => (pdf.toString("latin1").match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;

test("the fixture board: a cover and one page of cards, prompt cards for the plate that is absent", () => {
  const result = film("sheet", dir, ["--board", "shots.json", "--plates", "plates", "--out", "sheet"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(lines(result.stdout), ["sheet: 5 cards on 2 pages (a cover and 1 page of cards), 3 plates found, 2 prompt cards"]);
  const pdf = readFileSync(join(dir, "sheet", "sheet.pdf"));
  assert.equal(pdf.toString("latin1", 0, 5), "%PDF-");
  assert.equal(pageCount(pdf), 2);
  const report = JSON.parse(readFileSync(join(dir, "sheet", "sheet-report.json"), "utf8"));
  assert.equal(report.ok, true);
  assert.equal(report.pages, 2);
  assert.equal(report.cards, 5);
  assert.deepEqual(report.plates_found, ["p-dawn", "p-street", "p-window"]);
  assert.deepEqual(report.prompt_cards, ["s004", "s005"]);
  assert.deepEqual(report.face_flags, ["s005"]);
  assert.deepEqual(report.inputs, { board: join(dir, "shots.json"), plates: join(dir, "plates") });
  assert.deepEqual(report.outputs, { pdf: "sheet.pdf", html: "sheet.html", report: "sheet-report.json" });
  assert.deepEqual(readdirSync(join(dir, "sheet")).sort(), ["sheet-report.json", "sheet.html", "sheet.pdf"]);

  const html = readFileSync(join(dir, "sheet", "sheet.html"), "utf8");
  const card = (id: string) => {
    const at = html.indexOf(`data-shot="${id}"`);
    assert.ok(at >= 0, `no card for ${id}`);
    const end = html.indexOf("data-shot=", at + 10);
    return html.slice(at, end < 0 ? undefined : end);
  };
  // A plate that exists is the card's picture; one that does not is its prompt on the accent.
  assert.match(card("s001"), /<img [^>]*src="data:image\/png;base64,/);
  assert.doesNotMatch(card("s004"), /<img /);
  assert.match(card("s004"), /class="frame prompt" style="background:#3A7BD5"/);
  assert.match(card("s004"), /medium close-up of an adult performer on a rooftop/);
  // The card's fields: id, time, section, lines, framing, action, tier, the first device, FACE?.
  assert.match(card("s002"), /s002/);
  assert.match(card("s002"), /0\.98 to 5\.47 s/);
  assert.match(card("s002"), /Verse · lines 0, 1/);
  assert.match(card("s002"), /CU · sung/);
  assert.match(card("s002"), /She speaks the verse straight into the lens/);
  assert.match(card("s002"), /label · line 0 · W/);
  assert.match(card("s005"), /FACE\?/);
  assert.doesNotMatch(card("s004"), /FACE\?/);
  // The cover's chapter map.
  const cover = html.slice(0, html.indexOf('data-shot="s001"'));
  for (const text of ["ch01", "Wake", "0.00 to 6.46 s", "a city street at dawn", "#D97757", "the street", "ch02", "the roof"]) {
    assert.ok(cover.includes(text), `the cover has no ${text}`);
  }
  // Text from the board is escaped.
  assert.doesNotMatch(html, /<script/);
});

test("twelve cards a page: thirteen shots make a cover and two pages; text is escaped", () => {
  const board = changedBoard(dir, "thirteen.json", (b) => {
    const first = b.shots[0];
    b.shots = Array.from({ length: 13 }, (_, n) => ({
      ...first,
      id: `s${String(n + 1).padStart(3, "0")}`,
      t0: n,
      t1: n + 1,
      plate: n === 0 ? "p-dawn" : `p-${n}`,
      action: n === 1 ? "<script>alert(1)</script> & more" : String(first.action),
    }));
    b.duration = 13;
  });
  const result = film("sheet", dir, ["--board", board, "--plates", "plates", "--out", "thirteen"]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(pageCount(readFileSync(join(dir, "thirteen", "sheet.pdf"))), 3);
  const report = JSON.parse(readFileSync(join(dir, "thirteen", "sheet-report.json"), "utf8"));
  assert.equal(report.pages, 3);
  assert.equal(report.prompt_cards.length, 12);
  const html = readFileSync(join(dir, "thirteen", "sheet.html"), "utf8");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more"));
  assert.doesNotMatch(html, /<script/);
});

test("refusals: one line each on stdout, exit 2, nothing written", () => {
  writeFileSync(join(dir, "afile"), "x");
  const bad = changedBoard(dir, "bad.json", (_b, shot) => {
    shot("s001").framing = "XCU";
  });
  const cases: [string[], string][] = [
    [["--board", "shots.json", "--out", "x"], "film:sheet: --board, --plates and --out are required"],
    [["--board", "nope.json", "--plates", "plates", "--out", "x"], "--board cannot be read"],
    [["--board", "shots.json", "--plates", "nope", "--out", "x"], "--plates is not a folder"],
    [["--board", bad, "--plates", "plates", "--out", "x"], '--board: shots[0].framing is "XCU", want one of ECU, CU, MCU, MS, MWS, WS, FS, EWS, OTS'],
    [["--board", "shots.json", "--plates", "plates", "--out", "afile"], "--out is not a folder"],
  ];
  for (const [args, line] of cases) {
    const result = film("sheet", dir, args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stdout}${result.stderr}`);
    assert.deepEqual(lines(result.stdout), [line], args.join(" "));
    assert.equal(existsSync(join(dir, "x")), false);
  }
});

test("a browser that cannot start is exit 1 with one line on stderr, and no PDF", () => {
  mkdirSync(join(dir, "nobrowser"));
  const result = film("sheet", dir, ["--board", "shots.json", "--plates", "plates", "--out", "y"], { PLAYWRIGHT_BROWSERS_PATH: join(dir, "nobrowser") });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(lines(result.stderr), ["film:sheet: the browser could not be started"]);
  assert.equal(existsSync(join(dir, "y", "sheet.pdf")), false);
});
