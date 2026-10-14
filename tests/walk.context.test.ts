import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { newRecordingContext } from "../src/walk.ts";

// Every temp folder a test makes is removed once the file's tests are done.
const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

const PAGE = "<!doctype html><title>t</title><main><h1>synthetic</h1></main>";

test("the recording context leaves exactly one webm that ffprobe reads as 1920x1080", async () => {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(PAGE);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  const dir = mkdtempSync(join(tmpdir(), "studio-kit-context-"));
  temps.push(dir);
  const browser = await chromium.launch();
  try {
    const context = await newRecordingContext(browser, dir);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForSelector("main");
    await page.waitForTimeout(1000);
    await context.close();
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }

  const files = readdirSync(dir).filter((name) => name.endsWith(".webm"));
  assert.equal(files.length, 1, files.join(","));
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", join(dir, files[0])],
    { encoding: "utf8" },
  );
  assert.equal(probe.stdout.trim(), "1920,1080", probe.stderr);
});
