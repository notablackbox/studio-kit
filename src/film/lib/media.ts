import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { KIT_ROOT, Unexpected } from "./cli.ts";
import type { RunResult } from "../../render.ts";

// The rendering commands' seams to ffmpeg, ffprobe and Remotion: every child through the
// family-kill runner render.ts uses (a session of its own, a time limit, everything it started
// killed and reaped before this returns).

const MINUTE = 60 * 1000;
export const TOOL_TIMEOUT = 5 * MINUTE;
export const RENDER_TIMEOUT = 15 * MINUTE;
export const ENTRY = "src/remotion/Root.tsx";

export async function tool(command: string, args: string[], timeoutMs = TOOL_TIMEOUT, cwd?: string): Promise<RunResult> {
  const { runProcess } = await import("../../render.ts");
  const result = await runProcess(command, args, { timeoutMs, cwd });
  if (result.failure) throw new Unexpected(result.failure);
  if (result.timedOut) throw new Unexpected(`${command} took longer than ${timeoutMs / MINUTE} minutes`);
  return result;
}

// A tool that must succeed: its own output's tail goes to stderr only under FILM_DEBUG=1.
export async function must(what: string, command: string, args: string[], timeoutMs = TOOL_TIMEOUT, cwd?: string): Promise<RunResult> {
  const result = await tool(command, args, timeoutMs, cwd);
  if (result.status !== 0) {
    if (process.env.FILM_DEBUG === "1") {
      const tail = `${result.stdout}\n${result.stderr}`.split("\n").filter((l) => l.trim() !== "").slice(-30);
      console.error(tail.join("\n"));
    }
    throw new Unexpected(`${what} failed`);
  }
  return result;
}

export type VideoProbe = { width: number; height: number; fps: number; duration: number; codec: string; pix_fmt: string; color_primaries: string; color_transfer: string; color_space: string; size: number; audio: string | null };

// ffprobe's view of a video file: its first video stream, its first audio stream's codec, the
// container's duration and size. Null when it holds no video stream.
export async function probeVideo(file: string): Promise<VideoProbe | null> {
  const result = await tool("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,color_primaries,color_transfer,color_space:format=duration,size", "-of", "json", file]);
  if (result.status !== 0) return null;
  let parsed: { streams?: Record<string, unknown>[]; format?: Record<string, unknown> };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return null;
  }
  const video = parsed.streams?.find((s) => s.codec_type === "video");
  if (!video) return null;
  const audio = parsed.streams?.find((s) => s.codec_type === "audio");
  const [num, den] = String(video.r_frame_rate ?? "0/1").split("/").map(Number);
  return {
    width: Number(video.width),
    height: Number(video.height),
    fps: den ? Math.round((num / den) * 1000) / 1000 : 0,
    duration: Number(parsed.format?.duration),
    codec: String(video.codec_name ?? ""),
    pix_fmt: String(video.pix_fmt ?? ""),
    color_primaries: String(video.color_primaries ?? "unknown"),
    color_transfer: String(video.color_transfer ?? "unknown"),
    color_space: String(video.color_space ?? "unknown"),
    size: Number(parsed.format?.size),
    audio: audio ? String(audio.codec_name ?? "") : null,
  };
}

// An audio file's duration in seconds, or null when it holds no audio.
export async function audioSeconds(file: string): Promise<number | null> {
  const result = await tool("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=codec_type:format=duration", "-of", "json", file]);
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { streams?: { codec_type?: string }[]; format?: { duration?: string } };
    if (parsed.streams?.[0]?.codec_type !== "audio") return null;
    const d = Number(parsed.format?.duration);
    return Number.isFinite(d) ? d : null;
  } catch {
    return null;
  }
}

// `npx remotion <args>` from the kit root, with the kit's frame cache cap (render.ts).
export async function remotion(what: string, args: string[], timeoutMs = RENDER_TIMEOUT): Promise<void> {
  const { FRAME_CACHE_BYTES } = await import("../../render.ts");
  await must(what, "npx", ["remotion", ...args, "--log=error", `--offthreadvideo-cache-size-in-bytes=${FRAME_CACHE_BYTES}`], timeoutMs, KIT_ROOT);
}


// Moves a finished file from temp into a folder under `name`: copied to a fresh name beside it
// (temp may be another file system), then renamed over the final name, so a symlink at the name
// is replaced, never written through (as cli.ts's writeIn does).
export function moveIn(folder: string, name: string, from: string): string {
  mkdirSync(folder, { recursive: true });
  const target = join(folder, name);
  const temp = join(folder, `.${name}.${randomUUID()}.tmp`);
  try {
    copyFileSync(from, temp);
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
  rmSync(from, { force: true });
  return target;
}
