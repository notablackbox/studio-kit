import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXIT, KIT_ROOT, Refused, Unexpected, fromCaller, isMain, outProblem, parseFlags, refuseReportPaths, requireFile, run, writeIn, writeReport } from "./lib/cli.ts";
import { readBoard, type Board, type Chapter, type Shot } from "./lib/board.ts";

// film:sheet: the board as something a person can review on a phone (claudia.gallery's
// storyboard wiki, "The board review"; toolkit item 10). A cover page with the chapter map,
// then twelve cards a page, one per shot in time order: the plate where <plates>/<plate>.png
// (or .jpg) exists, else a prompt card (the prompt's text on the shot's accent); the id, the
// time, the section and lines, the framing and what moves, the action in one line, the first
// device in one line, and a FACE? badge when the notes mention a face. Printed to sheet.pdf
// (A4 landscape) by Chromium through Playwright; the HTML is written beside it.

const COMMAND = "film:sheet";
const PER_PAGE = 12;
const TIMEOUT_MS = 2 * 60 * 1000;
const DEFAULT_ACCENT = "#D97757";
const PROMPT_CHARS = 220;
const FONTS = join(KIT_ROOT, "brand", "fonts");

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const seconds = (t: number) => t.toFixed(2);
const clipped = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 3).trimEnd()}...` : text);

function font(family: string, file: string, format: string, weight: number): string {
  const data = readFileSync(join(FONTS, file)).toString("base64");
  return `@font-face{font-family:"${family}";src:url(data:font/${format};base64,${data}) format("${format === "ttf" ? "truetype" : "woff2"}");font-weight:${weight}}`;
}

const STYLE = `
@page{size:A4 landscape;margin:0}
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#fff;color:#111;font-family:"Inter",sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:297mm;height:209mm;padding:9mm 10mm;overflow:hidden;page-break-after:always;break-after:page;display:flex;flex-direction:column}
.page:last-child{page-break-after:auto;break-after:auto}
.head{display:flex;justify-content:space-between;align-items:baseline;font-family:"Plex Mono",monospace;font-size:8pt;color:#555;margin-bottom:4mm}
h1{font-family:"Anton",sans-serif;font-weight:400;font-size:40pt;letter-spacing:.5pt;line-height:1.05;margin-bottom:6mm}
table{border-collapse:collapse;width:100%;font-size:10pt}
th,td{text-align:left;padding:2.2mm 2mm;border-bottom:.3mm solid #ddd;vertical-align:top}
th{font-family:"Plex Mono",monospace;font-weight:500;font-size:8pt;color:#555}
.swatch{display:inline-block;width:4mm;height:4mm;border-radius:.6mm;vertical-align:-0.6mm;margin-right:1.5mm}
.grid{flex:1;display:grid;grid-template-columns:repeat(4,1fr);grid-template-rows:repeat(3,1fr);gap:4mm}
.card{border:.3mm solid #ccc;border-radius:1.2mm;overflow:hidden;display:flex;flex-direction:column;min-height:0}
.frame{position:relative;aspect-ratio:16/9;background:#222;overflow:hidden;flex:none}
.frame img{width:100%;height:100%;object-fit:cover;display:block}
.frame.prompt{color:#fff;font-size:6.6pt;line-height:1.3;padding:2mm}
.badge{position:absolute;top:1.5mm;right:1.5mm;background:#ffd400;color:#000;font-family:"Plex Mono",monospace;font-weight:500;font-size:7pt;padding:.4mm 1.2mm;border-radius:.6mm}
.meta{padding:1.6mm 2mm;font-size:7pt;line-height:1.35;display:flex;flex-direction:column;gap:.5mm;min-height:0;overflow:hidden}
.id{font-family:"Plex Mono",monospace;font-weight:500;font-size:8pt;display:flex;justify-content:space-between}
.mono{font-family:"Plex Mono",monospace;color:#444}
.one{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
`;

function cover(board: Board, title: string): string {
  const rows = board.chapters
    .map((c: Chapter) => {
      const accent = c.accent ?? DEFAULT_ACCENT;
      return `<tr><td class="mono">${escape(c.id)}</td><td>${escape(c.name ?? "")}</td><td class="mono">${seconds(c.t0)} to ${seconds(c.t1)} s</td><td>${escape(c.sections.join(", "))}</td><td>${escape(c.set ?? "")}</td><td class="mono"><span class="swatch" style="background:${accent}"></span>${escape(accent)}</td><td>${escape(c.box ?? "")}</td></tr>`;
    })
    .join("");
  const map = board.chapters.length > 0
    ? `<table><thead><tr><th>chapter</th><th>name</th><th>time</th><th>sections</th><th>set</th><th>accent</th><th>box</th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="mono">The board has no chapters yet.</p>`;
  return `<section class="page cover"><div class="head"><span>${escape(title)}</span><span>cover</span></div><h1>The board: ${board.shots.length} shots, ${seconds(board.duration)} s</h1>${map}</section>`;
}

function card(shot: Shot, image: string | null, accent: string): string {
  const face = /\bfaces?\b/i.test(shot.notes ?? "") ? `<span class="badge">FACE?</span>` : "";
  const frame = image
    ? `<div class="frame"><img src="${image}" alt="">${face}</div>`
    : `<div class="frame prompt" style="background:${accent}">${escape(clipped(shot.prompt ?? "(no prompt yet)", PROMPT_CHARS))}${face}</div>`;
  const device = shot.devices[0];
  const graphic = device ? `${device.kind} · line ${device.line ?? "-"} · ${device.key}` : "no graphic";
  const lines = shot.lines.length > 0 ? `lines ${shot.lines.join(", ")}` : "no lines";
  return `<div class="card" data-shot="${escape(shot.id)}">${frame}<div class="meta">
<div class="id"><span>${escape(shot.id)}</span><span>${seconds(shot.t0)} to ${seconds(shot.t1)} s</span></div>
<div class="one">${escape(shot.section ?? "no section")} · ${escape(lines)}</div>
<div class="mono one">${escape(shot.framing ?? "no framing")} · ${escape(shot.motion_tier ?? "no tier")}</div>
<div class="one">${escape(shot.action ?? "")}</div>
<div class="mono one">${escape(graphic)}</div>
</div></div>`;
}

// The plate's picture as a data URL, or null when the plates folder has none.
function plateImage(plates: string, plate: string | null): { url: string; file: string } | null {
  if (!plate) return null;
  for (const [ext, mime] of [["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"]] as const) {
    const file = join(plates, `${plate}.${ext}`);
    try {
      if (statSync(file).isFile()) return { url: `data:${mime};base64,${readFileSync(file).toString("base64")}`, file: `${plate}.${ext}` };
    } catch {
      // not this one
    }
  }
  return null;
}

async function printPdf(html: string): Promise<Buffer> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Unexpected("playwright could not be loaded");
  }
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ timeout: TIMEOUT_MS });
  } catch {
    throw new Unexpected("the browser could not be started");
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    const work = (async () => {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "load", timeout: TIMEOUT_MS });
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      return page.pdf({ format: "A4", landscape: true, printBackground: true, preferCSSPageSize: true });
    })();
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Unexpected(`the browser took longer than ${TIMEOUT_MS / 60000} minutes`)), TIMEOUT_MS);
    });
    return await Promise.race([work, limit]);
  } catch (error) {
    if (error instanceof Unexpected) throw error;
    throw new Unexpected("the browser could not print the sheet");
  } finally {
    if (timer) clearTimeout(timer);
    await browser.close().catch(() => undefined);
  }
}

// The pages of a PDF: its page objects, not the /Pages tree nodes.
export function pdfPages(pdf: Buffer): number {
  return (pdf.toString("latin1").match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
}

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, {
    board: { type: "string" },
    plates: { type: "string" },
    out: { type: "string" },
  });
  if (!values.board || !values.plates || !values.out) throw new Refused([`${COMMAND}: --board, --plates and --out are required`]);
  const boardFile = requireFile(fromCaller(values.board), "--board");
  const plates = fromCaller(values.plates);
  let folder = false;
  try {
    folder = statSync(plates).isDirectory();
  } catch {
    folder = false;
  }
  if (!folder) throw new Refused(["--plates is not a folder"]);
  const { board } = readBoard(boardFile);
  const out = fromCaller(values.out);
  const problem = outProblem(out);
  if (problem) throw new Refused([problem]);
  refuseReportPaths(out, "sheet", [["--board", boardFile]]);

  const chapterOf = (shot: Shot) => board.chapters.find((c) => shot.t0 >= c.t0 - 1e-6 && shot.t0 < c.t1 - 1e-6);
  const found = new Set<string>();
  const promptCards: string[] = [];
  const faces: string[] = [];
  const cards = board.shots.map((shot) => {
    const image = plateImage(plates, shot.plate);
    if (image && shot.plate) found.add(shot.plate);
    else promptCards.push(shot.id);
    if (/\bfaces?\b/i.test(shot.notes ?? "")) faces.push(shot.id);
    return card(shot, image?.url ?? null, shot.accent ?? chapterOf(shot)?.accent ?? DEFAULT_ACCENT);
  });
  const title = "storyboard";
  const pages: string[] = [cover(board, title)];
  const cardPages = Math.ceil(cards.length / PER_PAGE);
  for (let p = 0; p < cardPages; p++) {
    pages.push(
      `<section class="page"><div class="head"><span>${title}</span><span>page ${p + 1} of ${cardPages}</span></div><div class="grid">${cards.slice(p * PER_PAGE, (p + 1) * PER_PAGE).join("")}</div></section>`,
    );
  }
  const fonts = [font("Anton", "Anton-Regular.ttf", "ttf", 400), font("Inter", "Inter-Regular.woff2", "woff2", 400), font("Inter", "Inter-SemiBold.woff2", "woff2", 600), font("Plex Mono", "IBMPlexMono-Regular.ttf", "ttf", 400), font("Plex Mono", "IBMPlexMono-Medium.ttf", "ttf", 500)];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>${fonts.join("")}${STYLE}</style></head><body>${pages.join("")}</body></html>`;

  const pdf = await printPdf(html);
  const pageCount = pdfPages(pdf);
  if (pageCount !== pages.length) throw new Unexpected(`the sheet printed on ${pageCount} pages, not ${pages.length}`);
  writeIn(out, "sheet.pdf", pdf);
  writeIn(out, "sheet.html", html);
  const plateList = [...found].sort();
  writeReport(out, "sheet", {
    ok: true,
    inputs: { board: boardFile, plates },
    outputs: { pdf: "sheet.pdf", html: "sheet.html", report: "sheet-report.json" },
    pages: pageCount,
    cards: cards.length,
    plates_found: plateList,
    prompt_cards: promptCards,
    face_flags: faces,
  });
  console.log(
    `sheet: ${cards.length} cards on ${pageCount} pages (a cover and ${cardPages} page${cardPages === 1 ? "" : "s"} of cards), ${plateList.length} plate${plateList.length === 1 ? "" : "s"} found, ${promptCards.length} prompt card${promptCards.length === 1 ? "" : "s"}`,
  );
  return EXIT.done;
}

if (isMain(import.meta.url)) run(COMMAND, main);
