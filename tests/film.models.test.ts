import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The model download script on a folder that already holds models, and the refusal a command
// gives when a model is absent. Nothing here touches the network: downloads are forced offline.

const kitRoot = fileURLToPath(new URL("..", import.meta.url));

const temps: string[] = [];
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "studio-kit-film-models-"));
  temps.push(dir);
  return dir;
}

const lines = (text: string) => text.split("\n").filter((line) => line.trim() !== "");

function models(dest: string, only: string) {
  return spawnSync("python3", ["-I", "-B", "src/film/py/film_py/models.py", "--dest", dest, "--only", only], {
    cwd: kitRoot,
    encoding: "utf8",
    // Any download attempt fails at once instead of reaching the network.
    env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" },
  });
}

// A stand-in for the downloaded depth model: the files the script expects, with bytes of our own.
function fakeDepth(dest: string) {
  const folder = join(dest, "depth-anything-v2-small");
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "config.json"), "{}\n");
  writeFileSync(join(folder, "preprocessor_config.json"), "{}\n");
  writeFileSync(join(folder, "model.safetensors"), "not really weights");
  return folder;
}

const manifest = (dest: string) => JSON.parse(readFileSync(join(dest, "models.json"), "utf8"));

test("a model already in the folder, with no manifest, is found and marked present", () => {
  const dest = tempDir();
  const folder = fakeDepth(dest);
  const before = statSync(join(folder, "model.safetensors")).mtimeMs;
  const result = models(dest, "depth");
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const entry = manifest(dest).models.depth;
  assert.equal(entry.status, "present");
  assert.equal(entry.path, "depth-anything-v2-small");
  assert.deepEqual(
    entry.files.map((f: { file: string }) => f.file).sort(),
    ["depth-anything-v2-small/config.json", "depth-anything-v2-small/model.safetensors", "depth-anything-v2-small/preprocessor_config.json"],
  );
  assert.equal(readFileSync(join(folder, "model.safetensors"), "utf8"), "not really weights");
  assert.equal(statSync(join(folder, "model.safetensors")).mtimeMs, before);
});

test("an entry already in the manifest stays: present, never overwritten with missing", () => {
  const dest = tempDir();
  fakeDepth(dest);
  assert.equal(models(dest, "depth").status, 0);
  const first = manifest(dest).models.depth;

  // Run again with one model present and one absent (its download fails offline).
  const result = models(dest, "depth,whisper_tiny");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const after = manifest(dest).models;
  assert.equal(after.depth.status, "present");
  assert.equal(after.depth.path, first.path);
  assert.deepEqual(after.depth.files, first.files);
  assert.equal(after.whisper_tiny.status, "missing");
  assert.match(lines(result.stdout).join("\n"), /model depth: present/);
  assert.match(lines(result.stdout).join("\n"), /model whisper_tiny: missing/);
});

test("a manifest entry whose files are gone is not trusted", () => {
  const dest = tempDir();
  const folder = fakeDepth(dest);
  assert.equal(models(dest, "depth").status, 0);
  rmSync(folder, { recursive: true, force: true });
  const result = models(dest, "depth");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(manifest(dest).models.depth.status, "missing");
});

test("a command needing an absent model refuses with one line, the folder JSON-quoted", () => {
  const dest = join(tempDir(), "no\nmodels");
  const result = spawnSync(
    "python3",
    ["-I", "-B", "-c", "import sys; sys.path.insert(0, 'src/film/py'); from film_py import model; model('depth')"],
    { cwd: kitRoot, encoding: "utf8", env: { ...process.env, FILM_MODELS: dest } },
  );
  assert.equal(result.status, 2, result.stdout + result.stderr);
  const quoted = JSON.stringify(dest);
  assert.deepEqual(lines(result.stdout), [
    `model depth is not in ${quoted} (run python3 -I src/film/py/film_py/models.py --dest ${quoted})`,
  ]);
});
