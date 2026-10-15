// One heavy render at a time across the suite's test files. node --test runs several files at
// once, each in its own process; the Teaser's full master (render.test.ts) and the film chapter
// renders (film.chapter.test.ts) each drive Chromium and an encoder hard enough that, side by
// side on a 4-CPU, 6 GB container, a Remotion frame can pass its 30 s limit. Each takes this
// lock (a folder in the system temp folder, created atomically) for its renders; the rest of
// the suite runs beside them as before. Test-side only: the kit itself never takes it.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK = join(tmpdir(), "studio-kit-tests-heavy.lock");
const OWNER = join(LOCK, "owner");
const WAIT_MS = 20 * 60 * 1000;
const nap = new Int32Array(new SharedArrayBuffer(4));

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A lock whose owner has died, or whose owner never wrote its pid within 30 s, is taken over.
function stale(): boolean {
  try {
    const pid = Number(readFileSync(OWNER, "utf8"));
    return Number.isInteger(pid) && pid > 0 && !alive(pid);
  } catch {
    try {
      return Date.now() - statSync(LOCK).mtimeMs > 30_000;
    } catch {
      return false;
    }
  }
}

// Takes the lock, waiting (synchronously, so a `before` hook can call it) for the holder to let
// go; returns the release. After WAIT_MS it goes ahead without the lock rather than fail a test.
export function holdHeavy(): () => void {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(OWNER, String(process.pid));
      let held = true;
      const release = () => {
        if (!held) return;
        held = false;
        rmSync(LOCK, { recursive: true, force: true });
      };
      process.once("exit", release);
      return release;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (stale()) {
      rmSync(LOCK, { recursive: true, force: true });
      continue;
    }
    if (Date.now() > deadline) return () => {};
    Atomics.wait(nap, 0, 0, 250);
  }
}
