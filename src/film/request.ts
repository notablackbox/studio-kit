import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { EXIT, Refused, fromCaller, isMain, isOutPath, outProblem, parseFlags, refuseReportPaths, requireFile, run, shown, writeIn, writeReport } from "./lib/cli.ts";
import { idempotencyKey, readLedger, readProject, stateOf } from "./lib/ledger.ts";

// film:request shapes one paid call and makes none (spec D6 and 8.2). <id>.request.json is
// exactly the input of the harness's call_external tool for a clip (clips/<id>.json) or an
// image slot: the secret's name (never a value), the provider's URL, the method, the body
// with {{artifact:<id>}} placeholders for the plate and the window the skill saved as
// artifacts, the estimate, the idempotency key (SHA-256 of the production id, the provider,
// the model, the body and the attempt number: the ledger's asked rows for the reference, plus
// one; the production id is the `project` of the status.json beside the ledger), and `return`
// for an asynchronous video job (the job comes back to the skill) or `fetch_to` for a
// synchronous image. <id>.request.meta.json holds the kit's side: the reference, the attempt,
// the rates, the poll (a GET with no body on the provider's status URL) and the download
// (fetch_to applied to the result URL the poll returns). A reference the ledger
// marks declined on any provider is refused, and so is a prompt that breaks the seedance
// wiki's rules: a sung window of 4 to 8 s, the lyric in plain quotes (braces made the model
// re-sing), output settings in the request and never in the prompt, a short sung prompt.
// The URLs and rates are as documented on 2026-10-14; re-read them before any spend.
//
// --song and --wav are the same two files for Unifically, a hosted wrapper for Suno, as read on
// 2026-10-21: POST https://api.unifically.com/v1/tasks with {model, input}: suno-ai/music takes
// {mv, custom, prompt (the lyrics), tags, negative_tags, title, make_instrumental} and answers two
// clips in one task; suno-ai/wav takes {clip_id} and answers a WAV. Both are polled at GET
// /v1/tasks/{task_id}, and the answer is read as an envelope {data: {status, cost, clips[],
// wav_url}}: that envelope is confirmed on the first live call. A song task is estimated at
// SONG_RATE a task; a WAV export at WAV_ESTIMATE, the floor call_external accepts as an estimate
// (Film spec v1.4, section 6).

const COMMAND = "film:request";
const SUNG_WORDS_MAX = 110;
const SUNG_WORDS_WARN = 90;
const WINDOW_MIN = 4;
const WINDOW_MAX = 8;
const RESOLUTIONS = ["480p", "720p", "1080p"];
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TAKE = /^S\d{2}$/;
const SUNO_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SONG_RATE = 0.06;
const WAV_ESTIMATE = 0.01;

type Provider = "openrouter" | "higgsfield" | "unifically";
type SpecFlag = "--clip" | "--image" | "--song" | "--wav";
const SECRETS: Record<Provider, string> = { openrouter: "OPENROUTER_API_KEY", higgsfield: "HIGGSFIELD_API_KEY", unifically: "UNIFICALLY_API_KEY" };
const SPEC_WORD: Record<SpecFlag, string> = { "--clip": "clip", "--image": "image slot", "--song": "song task", "--wav": "take" };

// Where each model is asked, per provider. OpenRouter: one video endpoint for every video
// model (POST /api/v1/videos, polled at /api/v1/videos/{id}, fetched from .../content), and
// image models through chat completions. Higgsfield: one endpoint per model and mode, polled
// at /requests/{request_id}/status, the result at the completed status's video.url.
// `poll` names the submit response's id field in braces; `from` is the field of the completed
// status that holds the result URL.
type Route = { url: string; poll: string | null; from: string | null };
const OPENROUTER_VIDEO: Route = { url: "https://openrouter.ai/api/v1/videos", poll: "https://openrouter.ai/api/v1/videos/{id}", from: "unsigned_urls[0]" };
const OPENROUTER_CHAT: Route = { url: "https://openrouter.ai/api/v1/chat/completions", poll: null, from: null };
const higgsfield = (model: string, mode: string): Route => ({
  url: `https://api.higgsfield.ai/${model}/${mode}`,
  poll: "https://api.higgsfield.ai/requests/{request_id}/status",
  from: "video.url",
});
const VIDEO_MODELS: Record<Provider, Record<string, { reference: Route; first_frame: Route }>> = {
  openrouter: { "bytedance/seedance-2.5": { reference: OPENROUTER_VIDEO, first_frame: OPENROUTER_VIDEO } },
  higgsfield: {
    "bytedance/seedance-2.5": {
      reference: higgsfield("bytedance/seedance-2.5", "reference-to-video"),
      first_frame: higgsfield("bytedance/seedance-2.5", "image-to-video"),
    },
  },
  unifically: {},
};
// Unifically's one task endpoint, polled by task id; the WAV's result URL is data.wav_url.
const UNIFICALLY_SONG: Route = { url: "https://api.unifically.com/v1/tasks", poll: "https://api.unifically.com/v1/tasks/{task_id}", from: null };
const UNIFICALLY_WAV: Route = { ...UNIFICALLY_SONG, from: "data.wav_url" };
const IMAGE_MODELS: Partial<Record<Provider, Record<string, Route>>> = {
  openrouter: { "google/gemini-3-pro-image": OPENROUTER_CHAT },
};

// Dollars per second of video, per provider, model and resolution; dollars per image. The
// README's table: OpenRouter from its listed video-token price (1280x720 at 24 fps is 21,600
// tokens a second at $0.0000107), Higgsfield from the list price the films paid at 720p.
const VIDEO_RATES: Record<Provider, Record<string, Record<string, number>>> = {
  openrouter: { "bytedance/seedance-2.5": { "480p": 0.103, "720p": 0.231 } },
  higgsfield: { "bytedance/seedance-2.5": { "720p": 0.7 } },
  unifically: {},
};
const IMAGE_RATES: Partial<Record<Provider, Record<string, number>>> = {
  openrouter: { "google/gemini-3-pro-image": 0.14 },
};

// Output settings written into a prompt: they belong in the request body.
const SETTINGS =
  /\b\d{3,4}p\b|\b[48]k\b|\b\d+\s*fps\b|\bframes per second\b|\b(?:16:9|9:16|4:3|3:4|1:1|21:9|9:21)(?!\d)|\baspect ratio\b|\bresolution\b|\bduration\b|\b\d+(?:\.\d+)?[- ]?(?:seconds?|secs?|s)[- ](?:long|clip|video|shot)\b/gi;

// A timed beat in a prompt: `0-1s`, `2 to 3 s`, `at 1.5 s`.
const TIMED = /\b\d+(?:\.\d+)?(?:\s*(?:-|to)\s*\d+(?:\.\d+)?)?\s*s\b/g;
const TIMED_MAX = 2;

const isObject = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const wordCount = (text: string) => text.split(/\s+/).filter((w) => w !== "").length;
// Dollars rounded up to the cent (the tiny epsilon keeps 2.8000000000000003 at 2.80).
const cents = (usd: number) => Math.ceil(Math.round(usd * 100 * 1e6) / 1e6) / 100;
const money = (usd: number) => `$${usd.toFixed(2)}`;

function settingsIn(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(SETTINGS)].map((m) => m[0]))];
}

// The sung window's prompt in the wiki's short form (toolkit item 16): the head quoting every
// word, the clip's own line of framing and light, the closing line; about 90 words or fewer.
function sungPrompt(words: string, prompt: string): string {
  let own = prompt.trim();
  own = own.charAt(0).toUpperCase() + own.slice(1);
  if (!/[.!?]$/.test(own)) own += ".";
  return [
    "@Image1 sings @Audio1. Use @Image1 as the reference for her look, the set and the light.",
    "@Audio1 is her own voice and the whole soundtrack: copy it unchanged and add nothing.",
    `In @Audio1 she sings "${words.trim()}"; her lips form each word as it sounds and rest closed in the silences.`,
    own,
    "One continuous shot, no cuts, no head turns. Only she sings. No text, letters or logos.",
  ].join(" ");
}

function readSpec(path: string, flag: SpecFlag): Record<string, any> {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    value = null;
  }
  const what = SPEC_WORD[flag];
  if (!isObject(value)) throw new Refused([`${flag} is not a${/^[aeiou]/.test(what) ? "n" : ""} ${what} file`]);
  const file = basename(path);
  if (typeof value.id !== "string" || !ID.test(value.id)) throw new Refused([`${flag}: ${shown(file)} has no id that names a file`]);
  if (file.replace(/\.json$/i, "") !== value.id) throw new Refused([`${flag}: ${shown(file)} holds ${what} ${shown(value.id)}`]);
  return value;
}

// The ledger's side of a request: the production id, and the attempt after the ones asked.
function askedAttempt(ledger: string, id: string): { ledgerPath: string; project: string; attempt: number } {
  const ledgerPath = fromCaller(ledger);
  const state = stateOf(readLedger(ledgerPath), id);
  const project = readProject(ledgerPath);
  if (state.declined_on.length > 0) throw new Refused([`${shown(id)} was declined on ${state.declined_on.join(" and ")}: no request for it on any provider`]);
  return { ledgerPath, project, attempt: state.attempts + 1 };
}

// --out, refused before any write when it is not a folder or when an input sits where the request
// would write.
function outFolder(dir: string, flag: SpecFlag, specPath: string, ledgerPath: string, id: string): string {
  const out = fromCaller(dir);
  const problem = outProblem(out);
  if (problem) throw new Refused([problem]);
  refuseReportPaths(out, "request", [[flag, specPath], ["--ledger", ledgerPath]]);
  // Nor may an input be one of the two files the request writes in --out by its reference.
  const overwritten = ([[flag, specPath], ["--ledger", ledgerPath]] as [string, string][]).flatMap(([name, path]) =>
    [`${id}.request.json`, `${id}.request.meta.json`]
      .filter((named) => isOutPath(path, out, named))
      .map((named) => `${name} is ${shown(named)} in --out: the request would overwrite it`),
  );
  if (overwritten.length > 0) throw new Refused(overwritten);
  return out;
}

// A string field of a song task: present, and 1 to `max` characters.
function textProblem(spec: Record<string, any>, field: string, max: number): string | null {
  const value = spec[field];
  if (typeof value !== "string" || value.trim() === "") return `${shown(spec.id)} has no ${field}`;
  return value.length > max ? `${shown(spec.id)} ${field} is ${value.length} characters, want 1 to ${max}` : null;
}

// --song and --wav: a Unifically task and the WAV export of one of its takes.
function taskRequest(flag: "--song" | "--wav", spec: Record<string, any>, specPath: string, ledger: string, out: string, ratePerTask: number | null): number {
  const song = flag === "--song";
  const id: string = spec.id;
  const kind = song ? "song" : "wav";
  if (spec.kind !== kind) throw new Refused([`${shown(id)} kind is ${shown(spec.kind)}, want ${kind}`]);
  const problems: string[] = [];
  if (song) {
    problems.push(...[textProblem(spec, "title", 80), textProblem(spec, "tags", 1000), textProblem(spec, "lyrics", 5000)].filter((p) => p !== null));
    if (typeof spec.negative_tags !== "string") problems.push(`${shown(id)} negative_tags is ${shown(spec.negative_tags)}, want a string (may be empty)`);
    const takes = spec.takes;
    if (!Array.isArray(takes) || takes.length !== 2 || takes[0] === takes[1] || takes.some((t: unknown) => typeof t !== "string" || !TAKE.test(t))) {
      problems.push(`${shown(id)} takes wants exactly two keys like S01`);
    }
  } else {
    for (const field of ["clip_id", "task_id"]) {
      const value = spec[field];
      if (typeof value !== "string" || value === "") problems.push(`${shown(id)} has no ${field}`);
      else if (!SUNO_ID.test(value)) problems.push(`${shown(id)} ${field} wants letters, digits, . _ - (up to 128)`);
    }
  }
  if (problems.length > 0) throw new Refused(problems);

  const { ledgerPath, project, attempt } = askedAttempt(ledger, id);
  const outDir = outFolder(out, flag, specPath, ledgerPath, id);

  const modelId = song ? "suno-ai/music" : "suno-ai/wav";
  const rate = song ? (ratePerTask ?? SONG_RATE) : WAV_ESTIMATE;
  const estimate = cents(rate);
  const route = song ? UNIFICALLY_SONG : UNIFICALLY_WAV;
  const requestBody = song
    ? {
        model: modelId,
        input: { mv: "chirp-hawk", custom: true, prompt: spec.lyrics, tags: spec.tags, negative_tags: spec.negative_tags, title: spec.title, make_instrumental: false },
      }
    : { model: modelId, input: { clip_id: spec.clip_id } };
  const key = idempotencyKey(project, "unifically", modelId, requestBody, attempt);
  const fetchTo = song ? null : `song/${id}.wav`;
  const request = { secret: SECRETS.unifically, url: route.url, method: "POST", body: requestBody, estimate, idempotency_key: key, return: true };
  const name = `${id}.request.json`;
  const metaName = `${id}.request.meta.json`;
  const meta = {
    reference: id,
    kind,
    provider: "unifically",
    model: modelId,
    mode: song ? "custom" : "export",
    attempt,
    idempotency_key: key,
    estimate,
    ...(song
      ? { rate_per_task: rate, takes: spec.takes, prompt_words: wordCount(spec.lyrics) }
      : { clip_id: spec.clip_id, task_id: spec.task_id }),
    request: name,
    poll: { method: "GET", url: route.poll, body: null },
    download: fetchTo === null ? null : { from: route.from, fetch_to: fetchTo },
    ...(song ? { clips: "data.clips[]" } : {}),
  };
  writeIn(outDir, name, JSON.stringify(request, null, 2) + "\n");
  writeIn(outDir, metaName, JSON.stringify(meta, null, 2) + "\n");
  writeReport(outDir, "request", {
    ok: true,
    inputs: {
      clip: null,
      image: null,
      song: song ? specPath : null,
      wav: song ? null : specPath,
      provider: "unifically",
      ledger: ledgerPath,
      start_artifact: null,
      window_artifact: null,
      rate_per_second: null,
      rate_per_image: null,
      rate_per_task: ratePerTask,
      resolution: null,
    },
    outputs: { request: name, meta: metaName, report: "request-report.json" },
    reference: id,
    key,
    estimate,
    attempt,
    fetch_to: fetchTo,
    warnings: [],
  });
  console.log(`request: ${shown(id)} ${kind} on unifically, attempt ${attempt}${song ? `, ${spec.takes.length} takes` : ""}, estimate ${money(estimate)}, key ${key.slice(0, 12)}`);
  return EXIT.done;
}

async function main(): Promise<number> {
  const { values } = parseFlags(COMMAND, {
    clip: { type: "string" },
    image: { type: "string" },
    song: { type: "string" },
    wav: { type: "string" },
    provider: { type: "string" },
    ledger: { type: "string" },
    out: { type: "string" },
    "start-artifact": { type: "string" },
    "window-artifact": { type: "string" },
    "rate-per-second": { type: "string" },
    "rate-per-image": { type: "string" },
    "rate-per-task": { type: "string" },
    resolution: { type: "string" },
  });
  const given = ([["--clip", values.clip], ["--image", values.image], ["--song", values.song], ["--wav", values.wav]] as [SpecFlag, string | undefined][]).filter(([, path]) => path !== undefined);
  if (given.length === 0 || !values.provider || !values.ledger || !values.out) {
    throw new Refused([`${COMMAND}: --clip <clip.json>, --image <slot.json>, --song <task.json> or --wav <take.json>, --provider, --ledger and --out are required`]);
  }
  if (given.length > 1) throw new Refused([`${COMMAND}: give exactly one of --clip, --image, --song or --wav`]);
  const [flag, flagPath] = given[0];
  const isTask = flag === "--song" || flag === "--wav";
  if (!(values.provider in SECRETS)) throw new Refused([`--provider ${shown(values.provider)} has no known URL (openrouter, higgsfield or unifically)`]);
  const provider = values.provider as Provider;
  if (isTask) {
    if (provider !== "unifically") throw new Refused([`${flag} is answered by unifically only`]);
    // A song or a WAV export has no plate, window, resolution or per-second price; a WAV export's
    // estimate is the floor, so it has no per-task rate either.
    const unused = ["start-artifact", "window-artifact", "resolution", "rate-per-second", "rate-per-image", ...(flag === "--wav" ? ["rate-per-task"] : [])] as const;
    const refused = unused.filter((name) => values[name] !== undefined);
    if (refused.length > 0) throw new Refused(refused.map((name) => `${flag} takes no --${name}`));
  }
  if (values.resolution !== undefined && !RESOLUTIONS.includes(values.resolution)) {
    throw new Refused([`--resolution is ${shown(values.resolution)}, want 480p, 720p or 1080p`]);
  }
  const rateFlag = (name: "rate-per-second" | "rate-per-image" | "rate-per-task"): number | null => {
    const text = values[name];
    if (text === undefined) return null;
    const rate = Number(text);
    if (!/^\d+(\.\d+)?$/.test(text) || !Number.isFinite(rate) || !(rate > 0)) throw new Refused([`--${name} is ${shown(text)}, want dollars above 0`]);
    return rate;
  };
  const ratePerSecond = rateFlag("rate-per-second");
  const ratePerImage = rateFlag("rate-per-image");
  const ratePerTask = rateFlag("rate-per-task");
  for (const name of ["start-artifact", "window-artifact"] as const) {
    const id = values[name];
    if (id !== undefined && !ARTIFACT.test(id)) throw new Refused([`--${name} wants an artifact id (letters, digits, . _ : -)`]);
  }

  const specPath = requireFile(fromCaller(flagPath!), flag);
  const spec = readSpec(specPath, flag);
  if (flag === "--song" || flag === "--wav") return taskRequest(flag, spec, specPath, values.ledger, values.out, ratePerTask);
  const isClip = flag === "--clip";
  const id: string = spec.id;
  const start = values["start-artifact"];
  const windowArtifact = values["window-artifact"];

  const problems: string[] = [];
  const warnings: string[] = [];
  let kind: "sung" | "motion" | "image";
  if (isClip) {
    if (spec.kind !== "sung" && spec.kind !== "motion") throw new Refused([`${shown(id)} kind is ${shown(spec.kind)}, want sung or motion`]);
    kind = spec.kind;
    if (kind === "sung" && windowArtifact === undefined) throw new Refused([`${shown(id)} is sung: --window-artifact is required`]);
    if (kind === "motion" && windowArtifact !== undefined) throw new Refused([`${shown(id)} is a motion clip: it takes no --window-artifact`]);
    if (start === undefined) throw new Refused(["--start-artifact is required for a clip"]);
  } else {
    kind = "image";
    if (start !== undefined || windowArtifact !== undefined) throw new Refused(["--image takes no --start-artifact or --window-artifact"]);
  }

  // The spec's own fields: every problem, one line each.
  const body = isObject(spec.body) ? spec.body : {};
  const authored: unknown = kind === "image" ? spec.prompt : body.prompt;
  const prompt = typeof authored === "string" && authored.trim() !== "" ? authored : null;
  const model: unknown = spec.model;
  if (typeof model !== "string" || model === "") problems.push(`${shown(id)} has no model`);
  if (prompt === null) problems.push(`${shown(id)} has no ${kind === "image" ? "prompt" : "body.prompt"}`);
  let duration = 0;
  let windowSpan: [number, number] | null = null;
  if (kind !== "image") {
    if (typeof spec.start !== "string" || spec.start === "") problems.push(`${shown(id)} has no start`);
    duration = Number(body.duration);
    // A finite number of seconds: 1e309 in the JSON, or the string "Infinity", is not one.
    if (body.duration === undefined) problems.push(`${shown(id)} has no body.duration`);
    else if (!Number.isFinite(duration) || !(duration > 0)) {
      const value = typeof body.duration === "number" ? String(body.duration) : shown(body.duration);
      problems.push(`${shown(id)} body.duration is ${value}, want seconds above 0`);
    }
  }
  if (kind === "sung") {
    const w = spec.window;
    if (!isObject(w) || !Number.isFinite(w.t0) || !Number.isFinite(w.t1)) problems.push(`${shown(id)} has no window`);
    else windowSpan = [w.t0 as number, w.t1 as number];
    if (typeof spec.words !== "string" || spec.words.trim() === "") problems.push(`${shown(id)} has no words`);
  }
  // An image slot's refs, when present, is a list of artifact ids; anything else is not read as none.
  if (kind === "image" && spec.refs !== undefined) {
    if (!Array.isArray(spec.refs)) problems.push(`${shown(id)} refs is ${shown(spec.refs)}, want a list of artifact ids`);
    else if (spec.refs.some((r: unknown) => typeof r !== "string" || !ARTIFACT.test(r))) problems.push(`${shown(id)} refs want artifact ids (letters, digits, . _ : -)`);
  }
  if (windowSpan) {
    const length = windowSpan[1] - windowSpan[0];
    if (!(length >= WINDOW_MIN && length <= WINDOW_MAX)) {
      problems.push(`${shown(id)} window is ${length.toFixed(2)} s (${windowSpan[0].toFixed(2)} to ${windowSpan[1].toFixed(2)}), want 4 to 8 s`);
    }
  }
  if (kind === "sung" && typeof spec.words === "string" && /[{}]/.test(spec.words)) problems.push(`${shown(id)} words have braces: the lyric goes in plain quotes`);
  if (kind === "sung" && typeof spec.words === "string" && spec.words.includes('"')) problems.push(`${shown(id)} words have a double quote: the kit quotes the lyric`);
  if (kind === "sung" && prompt !== null && /[{}]/.test(prompt)) problems.push(`${shown(id)} prompt has braces: the lyric goes in plain quotes`);
  if (prompt !== null) {
    const found = settingsIn(prompt);
    if (found.length > 0) problems.push(`${shown(id)} prompt has output settings (${found.map((s) => shown(s)).join(", ")}): they go in the request, never the prompt`);
  }
  const text = kind === "sung" && prompt !== null && typeof spec.words === "string" ? sungPrompt(spec.words, prompt) : prompt;
  if (kind === "sung" && text !== null) {
    const n = wordCount(text);
    if (n > SUNG_WORDS_MAX) problems.push(`${shown(id)} sung prompt is ${n} words, want ${SUNG_WORDS_MAX} or fewer`);
    else if (n > SUNG_WORDS_WARN) warnings.push(`${shown(id)} sung prompt is ${n} words: a sung window copies best at about ${SUNG_WORDS_WARN} or fewer`);
    const beats = prompt === null ? 0 : [...prompt.matchAll(TIMED)].length;
    if (beats > TIMED_MAX) warnings.push(`${shown(id)} sung prompt has ${beats} timed beats: a sung window copies best with two or fewer`);
  }
  if (problems.length > 0) throw new Refused(problems);

  // Where it goes and what it costs.
  const modelId = model as string;
  const mode = kind === "image" ? "chat" : kind === "sung" ? "reference" : "first_frame";
  const route = kind === "image" ? IMAGE_MODELS[provider]?.[modelId] : VIDEO_MODELS[provider][modelId]?.[mode as "reference" | "first_frame"];
  if (!route) throw new Refused([`${shown(id)} model ${shown(modelId)} has no known URL on ${provider}`]);
  const resolution = values.resolution ?? (typeof body.resolution === "string" ? body.resolution : "720p");
  if (kind !== "image" && !RESOLUTIONS.includes(resolution)) throw new Refused([`${shown(id)} body.resolution is ${shown(resolution)}, want 480p, 720p or 1080p`]);
  let rate: number | undefined;
  if (kind === "image") {
    rate = ratePerImage ?? IMAGE_RATES[provider]?.[modelId];
    if (rate === undefined) throw new Refused([`no rate for ${modelId} on ${provider}: give --rate-per-image`]);
  } else {
    rate = ratePerSecond ?? VIDEO_RATES[provider][modelId]?.[resolution];
    if (rate === undefined) throw new Refused([`no rate for ${modelId} on ${provider} at ${resolution}: give --rate-per-second`]);
  }
  const estimate = cents(kind === "image" ? rate : duration * rate);

  // The ledger: a declined reference is closed on every provider; the attempt is the next one.
  const { ledgerPath, project, attempt } = askedAttempt(values.ledger, id);
  const out = outFolder(values.out, flag, specPath, ledgerPath, id);

  // The body, in the provider's own shape. Output settings are fields here, never prompt words.
  const placeholder = (artifact: string) => `{{artifact:${artifact}}}`;
  const aspect = typeof body.aspect_ratio === "string" ? body.aspect_ratio : "16:9";
  let requestBody: Record<string, unknown>;
  if (kind === "image") {
    const refs: string[] = spec.refs ?? [];
    requestBody = {
      model: modelId,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text }, ...refs.map((r) => ({ type: "image_url", image_url: { url: placeholder(r) } }))],
        },
      ],
      modalities: ["image", "text"],
      image_config: { aspect_ratio: typeof spec.aspect_ratio === "string" ? spec.aspect_ratio : "16:9" },
    };
  } else if (provider === "openrouter") {
    // Reference mode for a sung window: on OpenRouter a first frame drops the audio reference.
    requestBody = {
      model: modelId,
      prompt: text,
      duration,
      resolution,
      aspect_ratio: aspect,
      generate_audio: kind === "sung",
      ...(kind === "sung"
        ? {
            input_references: [
              { type: "image_url", image_url: { url: placeholder(start!) } },
              { type: "audio_url", audio_url: { url: placeholder(windowArtifact!) } },
            ],
          }
        : { frame_images: [{ type: "image_url", image_url: { url: placeholder(start!) }, frame_type: "first_frame" }] }),
    };
  } else if (kind === "sung") {
    requestBody = {
      prompt: text,
      duration,
      resolution,
      aspect_ratio: aspect,
      generate_audio: true,
      image_urls: [placeholder(start!)],
      audio_urls: [placeholder(windowArtifact!)],
    };
  } else {
    // Higgsfield's image-to-video takes no aspect ratio: the first frame sets it.
    requestBody = { prompt: text, duration, resolution, generate_audio: false, image_url: placeholder(start!) };
  }

  const key = idempotencyKey(project, provider, modelId, requestBody, attempt);
  const fetchTo = kind === "image" ? `plates/cands/${id}/${attempt}.json` : `clips/${id}/take-${attempt}.mp4`;
  // call_external's input, and nothing else: the skill adds the tranche it opened.
  const request = {
    secret: SECRETS[provider],
    url: route.url,
    method: "POST",
    body: requestBody,
    estimate,
    idempotency_key: key,
    ...(kind === "image" ? { fetch_to: fetchTo } : { return: true }),
  };
  const name = `${id}.request.json`;
  const metaName = `${id}.request.meta.json`;
  const meta = {
    reference: id,
    kind,
    provider,
    model: modelId,
    mode,
    attempt,
    idempotency_key: key,
    estimate,
    ...(kind === "image" ? { rate_per_image: rate } : { duration, resolution, rate_per_second: rate }),
    prompt_words: wordCount(text ?? ""),
    request: name,
    // Submit (return), poll until done, download the result URL the poll returns.
    poll: route.poll === null ? null : { method: "GET", url: route.poll, body: null },
    download: route.from === null ? null : { from: route.from, fetch_to: fetchTo },
  };
  writeIn(out, name, JSON.stringify(request, null, 2) + "\n");
  writeIn(out, metaName, JSON.stringify(meta, null, 2) + "\n");
  writeReport(out, "request", {
    ok: true,
    inputs: {
      clip: isClip ? specPath : null,
      image: isClip ? null : specPath,
      song: null,
      wav: null,
      provider,
      ledger: ledgerPath,
      start_artifact: start ?? null,
      window_artifact: windowArtifact ?? null,
      rate_per_second: ratePerSecond,
      rate_per_image: ratePerImage,
      rate_per_task: null,
      resolution: values.resolution ?? null,
    },
    outputs: { request: name, meta: metaName, report: "request-report.json" },
    reference: id,
    key,
    estimate,
    attempt,
    fetch_to: fetchTo,
    warnings,
  });
  const what = kind === "image" ? "" : `, ${duration} s at ${resolution}`;
  console.log(`request: ${shown(id)} ${kind} on ${provider}, attempt ${attempt}${what}, estimate ${money(estimate)}, key ${key.slice(0, 12)}`);
  for (const warning of warnings) console.log(`warning: ${warning}`);
  return EXIT.done;
}

if (isMain(import.meta.url)) run(COMMAND, main);
