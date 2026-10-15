import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT, Refused, Unexpected, fromCaller, isMain, outProblem, parseFlags, requireFile, run, shown, writeIn, writeReport } from "./lib/cli.ts";
import { RENDER_TIMEOUT, audioSeconds, moveIn, must, probeVideo, type VideoProbe } from "./lib/media.ts";

// film:encode: the deliverables (motion wiki, "Encode"; toolkit item 25). The chapter videos,
// in the order given, through ffmpeg's concat demuxer, with the mix muxed in (AAC 256k):
// `master.mp4` at CRF 16, preset slow, yuv420p, converted to and tagged BT.709 (primaries,
// transfer, matrix; an untagged stream looks washed out in QuickTime), and `review.mp4` at
// CRF 20 capped at 8 Mb/s. Both are read back with ffprobe: the duration must equal the
// chapters' sum within 0.5 s, the three BT.709 tags must be there, and the rate 24 fps; a file
// that does not measure up is a failure of the encode (exit 1).

const COMMAND = "film:encode";
const FPS = 24;

const tags = ["-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv"];

function check(name: string, p: VideoProbe | null, want: { duration: number; width: number; height: number }): string[] {
  if (!p) return [`${name} cannot be read back`];
  const problems: string[] = [];
  if (Math.abs(p.duration - want.duration) > 0.5) problems.push(`${name} runs ${p.duration.toFixed(3)} s, the chapters ${want.duration.toFixed(3)} s`);
  if (p.fps !== FPS) problems.push(`${name} runs at ${p.fps} fps, want ${FPS}`);
  for (const [key, value] of [["color_primaries", p.color_primaries], ["color_transfer", p.color_transfer], ["color_space", p.color_space]] as const) {
    if (value !== "bt709") problems.push(`${name} has ${key} ${value}, want bt709`);
  }
  if (p.codec !== "h264" || p.pix_fmt !== "yuv420p") problems.push(`${name} is ${p.codec} ${p.pix_fmt}, want h264 yuv420p`);
  if (p.width !== want.width || p.height !== want.height) problems.push(`${name} measures ${p.width}x${p.height}, the chapters ${want.width}x${want.height}`);
  if (p.audio !== "aac") problems.push(`${name} has no AAC sound`);
  return problems;
}

async function main(): Promise<number> {
  const { values, positionals } = parseFlags(COMMAND, { chapters: { type: "string", multiple: true }, mix: { type: "string" }, out: { type: "string" } }, process.argv.slice(2), true);
  const chapters = [...(values.chapters ?? []), ...positionals].map(fromCaller);
  if (chapters.length === 0 || !values.mix || !values.out) throw new Refused([`${COMMAND}: --chapters <mp4>..., --mix and --out are required`]);
  const problems: string[] = [];
  const probes: VideoProbe[] = [];
  for (const file of chapters) {
    requireFile(file, "--chapters");
    const p = await probeVideo(file);
    if (!p || !Number.isFinite(p.duration)) problems.push(`--chapters: ${shown(file.split("/").pop())} cannot be read as a video`);
    else probes.push(p);
  }
  if (probes.length === chapters.length) {
    const [first] = probes;
    probes.forEach((p, k) => {
      if (p.width !== first.width || p.height !== first.height) problems.push(`--chapters: ${shown(chapters[k].split("/").pop())} measures ${p.width}x${p.height}, the first ${first.width}x${first.height}`);
      if (p.fps !== FPS) problems.push(`--chapters: ${shown(chapters[k].split("/").pop())} runs at ${p.fps} fps, want ${FPS}`);
    });
  }
  const mix = requireFile(fromCaller(values.mix), "--mix");
  const mixSeconds = await audioSeconds(mix);
  if (mixSeconds === null) problems.push("--mix cannot be read as audio");
  const out = fromCaller(values.out);
  const issue = outProblem(out);
  if (issue) problems.push(issue);
  if (problems.length > 0) throw new Refused(problems);

  const total = probes.reduce((s, p) => s + p.duration, 0);
  const size = { width: probes[0].width, height: probes[0].height };
  const temp = mkdtempSync(join(tmpdir(), "studio-kit-encode-"));
  try {
    // The concat list: each path single-quoted, a quote inside written as '\''.
    const list = chapters.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n") + "\n";
    writeIn(temp, "chapters.txt", list);
    const vf = "scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv";
    const common = ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(temp, "chapters.txt"), "-i", mix, "-map", "0:v:0", "-map", "1:a:0", "-t", total.toFixed(3), "-vf", vf, "-r", String(FPS), "-c:v", "libx264", "-pix_fmt", "yuv420p", ...tags, "-c:a", "aac", "-b:a", "256k", "-ac", "2", "-movflags", "+faststart"];
    const encoded: Record<string, VideoProbe> = {};
    for (const [name, rate] of [["master.mp4", ["-crf", "16", "-preset", "slow"]], ["review.mp4", ["-crf", "20", "-preset", "slow", "-maxrate", "8M", "-bufsize", "16M"]]] as const) {
      const file = join(temp, name);
      await must(`encoding ${name}`, "ffmpeg", [...common, ...rate, file], RENDER_TIMEOUT);
      const p = await probeVideo(file);
      const wrong = check(name, p, { duration: total, ...size });
      if (wrong.length > 0) throw new Unexpected(wrong.join("; "));
      encoded[name] = p as VideoProbe;
    }
    for (const name of Object.keys(encoded)) moveIn(out, name, join(temp, name));
    const view = (p: VideoProbe) => ({ duration: p.duration, size: p.size, width: p.width, height: p.height, fps: p.fps, codec: p.codec, pix_fmt: p.pix_fmt, color_primaries: p.color_primaries, color_transfer: p.color_transfer, color_space: p.color_space, audio: p.audio });
    writeReport(out, "encode", {
      ok: true,
      inputs: { chapters, mix },
      outputs: { master: "master.mp4", review: "review.mp4", report: "encode-report.json" },
      chapters: chapters.map((f, k) => ({ file: f, duration: probes[k].duration })),
      chapters_seconds: Math.round(total * 1000) / 1000,
      mix_seconds: mixSeconds,
      master: view(encoded["master.mp4"]),
      review: view(encoded["review.mp4"]),
      settings: { master: "libx264 -crf 16 -preset slow yuv420p bt709", review: "libx264 -crf 20 -maxrate 8M -bufsize 16M yuv420p bt709", audio: "aac 256k stereo" },
    });
    const m = encoded["master.mp4"];
    console.log(`encode: master.mp4 ${m.duration.toFixed(3)} s (the chapters ${total.toFixed(3)} s), ${m.width}x${m.height} ${m.fps} fps, bt709, ${m.size} bytes; review.mp4 ${encoded["review.mp4"].size} bytes`);
    return EXIT.done;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) run(COMMAND, main);
