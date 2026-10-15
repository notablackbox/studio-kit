"""The synthetic song the film tests listen to, with exact ground truth.

    python3 -I tests/fixtures/synth_song.py --out <dir> [--lyrics <lyrics.txt>]

Writes into --out:
- song.wav: 16-bit 44.1 kHz stereo, 12.0 s: the vocals over the drums, sample for sample the
  sum of the two stems below;
- vocals.wav, drums.wav: the two stems, the same format;
- lyrics.txt: the lyric sheet, two bracketed sections;
- display.txt: the words as the screen shows them, one display token per sung word;
- truth.json: every word's start and end, every beat, the downbeats, the kick, snare and hat
  times, the section boundaries, the tempo law, the voice.

Words are spoken by espeak-ng one at a time (voice en-us, speed 150, pitch 50), each trimmed
to its first and last sample above 1 percent of full scale, so a word's start and end are the
first and last samples of its audio. Each starts on an eighth note of the drifting grid. The
drums are generated with numpy from a fixed seed: kick on beats 1 and 3, snare on 2 and 4, a
hat on every off-beat eighth. The tempo rises linearly in time from 120 BPM at the first beat
to 123 BPM at the end of the file. Everything is deterministic: two builds are byte for byte
the same (for one espeak-ng version).
"""

import argparse
import json
import math
import re
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

RATE = 44100
DURATION = 12.0
SAMPLES = int(round(DURATION * RATE))
FIRST_BEAT = 0.5
START_BPM = 120.0
END_BPM = 123.0
SEED = 20261015
VOICE = {"engine": "espeak-ng", "voice": "en-us", "speed": 150, "pitch": 50, "amplitude": 100}
VOCAL_PEAK = 0.4
DRUM_PEAK = 0.5
WORD_GAP = 0.06  # seconds of silence at least between two words
LINE_GAP = 0.25  # and between two lines

LYRICS = """[Verse - spoken, deadpan]
the city wakes
we count the windows
[Chorus - sung]
hold on
hold the light
"""

DISPLAY = """The city wakes.
We count the windows.
Hold on,
hold the light.
"""


def beat_time(k: float) -> float:
    """The time of beat phase k: tempo linear in time, START_BPM at FIRST_BEAT, END_BPM at the end."""
    span = DURATION - FIRST_BEAT
    a = (END_BPM - START_BPM) / (2 * span * 60)  # phase = a tau^2 + b tau
    b = START_BPM / 60
    return FIRST_BEAT + (-b + math.sqrt(b * b + 4 * a * k)) / (2 * a)


def frame(t: float) -> int:
    return int(round(t * RATE))


def parse_sheet(text: str):
    sections, lines = [], []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if re.fullmatch(r"\[.*\]", line):
            name = re.split(r"\s+-\s+|:", line[1:-1].strip(), maxsplit=1)[0].strip()
            sections.append({"name": name, "cue": line})
            continue
        if not sections:
            raise SystemExit("the lyric sheet must start with a [section] cue")
        words = line.split()
        if not all(re.fullmatch(r"[a-z']+", w) for w in words):
            raise SystemExit(f"lyric words must be lower-case letters: {line!r}")
        lines.append({"text": line, "section": len(sections) - 1, "words": words})
    if len(sections) != 2:
        raise SystemExit("the lyric sheet must have two sections")
    return sections, lines


def upsample_2x(x: np.ndarray) -> np.ndarray:
    """22.05 kHz to 44.1 kHz: zeros between samples, then a windowed-sinc low-pass."""
    stuffed = np.zeros(len(x) * 2)
    stuffed[::2] = x
    taps = 63
    n = np.arange(taps) - (taps - 1) / 2
    h = np.sinc(n / 2) * np.blackman(taps)  # cut-off at the old Nyquist; gain 2 restores level
    return np.convolve(stuffed, h, mode="same")


def speak(word: str, work: Path) -> np.ndarray:
    path = work / f"{word}.wav"
    subprocess.run(
        ["espeak-ng", "-v", VOICE["voice"], "-s", str(VOICE["speed"]), "-p", str(VOICE["pitch"]), "-a", str(VOICE["amplitude"]), "-w", str(path), word],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    with wave.open(str(path), "rb") as w:
        if w.getsampwidth() != 2 or w.getnchannels() != 1 or w.getframerate() != RATE // 2:
            raise SystemExit(f"espeak-ng wrote an unexpected format for {word!r}")
        x = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float64) / 32768
    y = upsample_2x(x)
    loud = np.flatnonzero(np.abs(y) > 0.01 * np.max(np.abs(y)))
    y = y[loud[0] : loud[-1] + 1]
    y = y / np.max(np.abs(y)) * VOCAL_PEAK
    fade = min(int(0.002 * RATE), len(y) // 4)
    if fade > 0:
        ramp = np.linspace(0.25, 1.0, fade)  # never to zero: the first and last samples stay sound
        y[:fade] *= ramp
        y[-fade:] *= ramp[::-1]
    return y


def drum_sounds(rng: np.random.Generator):
    t = np.arange(int(0.30 * RATE)) / RATE
    freq = 45 + 75 * np.exp(-t / 0.03)
    kick = np.cos(2 * np.pi * np.cumsum(freq) / RATE) * np.exp(-t / 0.12)
    t = np.arange(int(0.20 * RATE)) / RATE
    snare = 0.6 * rng.uniform(-1, 1, len(t)) * np.exp(-t / 0.06) + 0.5 * np.cos(2 * np.pi * 185 * t) * np.exp(-t / 0.05)
    t = np.arange(int(0.05 * RATE)) / RATE
    noise = rng.uniform(-1, 1, len(t) + 2)
    hat = 0.5 * np.diff(noise, 2) / 4 * np.exp(-t / 0.012)
    hat[0] = 0.35  # a hat starts on its first sample
    return kick, snare, hat


def place(track: np.ndarray, sound: np.ndarray, at: int) -> None:
    end = min(len(track), at + len(sound))
    track[at:end] += sound[: end - at]


def to_int16(x: np.ndarray) -> np.ndarray:
    return np.clip(np.round(x * 32767), -32768, 32767).astype("<i2")


def write_wav(path: Path, mono_int16: np.ndarray) -> None:
    stereo = np.repeat(mono_int16[:, None], 2, axis=1)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(stereo.astype("<i2").tobytes())


def espeak_version() -> str:
    out = subprocess.run(["espeak-ng", "--version"], check=True, capture_output=True, text=True).stdout
    match = re.search(r"\d+\.\d+(\.\d+)?", out)
    return match.group(0) if match else out.strip()


def build(out: Path, lyrics: str, display: str) -> dict:
    sections, lines = parse_sheet(lyrics)
    display_lines = [l.split() for l in display.splitlines() if l.strip()]
    if len(display_lines) != len(lines) or any(len(d) != len(l["words"]) for d, l in zip(display_lines, lines)):
        raise SystemExit("display.txt must hold one token per lyric word, line for line")

    n_beats = 0
    while beat_time(n_beats) < DURATION - 0.05:
        n_beats += 1
    beats = [frame(beat_time(k)) for k in range(n_beats)]

    rng = np.random.default_rng(SEED)
    kick, snare, hat = drum_sounds(rng)
    drums = np.zeros(SAMPLES)
    kicks, snares, hats = [], [], []
    for k, at in enumerate(beats):
        if k % 2 == 0:
            place(drums, kick, at)
            kicks.append(at)
        else:
            place(drums, 0.8 * snare, at)
            snares.append(at)
        if k + 1 < n_beats:
            at_hat = frame(beat_time(k + 0.5))
            place(drums, hat, at_hat)
            hats.append(at_hat)
    drums = drums / np.max(np.abs(drums)) * DRUM_PEAK

    vocals = np.zeros(SAMPLES)
    words, line_truth, section_starts = [], [], []
    phase = 0.0  # the eighth-note grid, in beats
    end_time = 0.0
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        for index, line in enumerate(lines):
            if index == 0 or line["section"] != lines[index - 1]["section"]:
                # A section opens on the downbeat after the last word, its first word on beat 2.
                bar = 0 if index == 0 else math.floor(phase / 4) + 1
                while index and beat_time(4 * bar) < end_time + LINE_GAP:
                    bar += 1
                section_starts.append(4 * bar)
                phase = 4 * bar + 1
            gap = LINE_GAP if index and line["section"] == lines[index - 1]["section"] else 0.0
            first = len(words)
            for w_index, word in enumerate(line["words"]):
                audio = speak(word, work)
                need = end_time + (gap if w_index == 0 else WORD_GAP) if words else 0.0
                while beat_time(phase) < need:
                    phase += 0.5
                start = frame(beat_time(phase))
                stop = start + len(audio)
                if stop > SAMPLES - frame(0.5):
                    raise SystemExit("the lyric does not fit in 12 seconds")
                vocals[start:stop] += audio
                words.append(
                    {
                        "i": len(words),
                        "word": word,
                        "display": display_lines[index][w_index],
                        "line": index,
                        "section": line["section"],
                        "start": round(start / RATE, 6),
                        "end": round(stop / RATE, 6),
                    }
                )
                end_time = stop / RATE
                phase += 0.5
            line_truth.append(
                {
                    "text": line["text"],
                    "display": " ".join(display_lines[index]),
                    "section": line["section"],
                    "words": [first, len(words) - 1],
                }
            )

    vocal_int = to_int16(vocals)
    drum_int = to_int16(drums)
    song_int = vocal_int.astype(np.int32) + drum_int.astype(np.int32)
    if np.any(np.abs(song_int) > 32767):
        raise SystemExit("the mix clips")
    song_int = song_int.astype("<i2")

    out.mkdir(parents=True, exist_ok=True)
    write_wav(out / "song.wav", song_int)
    write_wav(out / "vocals.wav", vocal_int)
    write_wav(out / "drums.wav", drum_int)
    (out / "lyrics.txt").write_text(lyrics, encoding="utf-8")
    (out / "display.txt").write_text(display, encoding="utf-8")

    seconds = lambda frames: [round(f / RATE, 6) for f in frames]  # noqa: E731
    bounds = [0.0] + [round(frame(beat_time(b)) / RATE, 6) for b in section_starts[1:]] + [round(SAMPLES / RATE, 6)]
    truth = {
        "version": 1,
        "sample_rate": RATE,
        "channels": 2,
        "samples": SAMPLES,
        "duration": round(SAMPLES / RATE, 6),
        "seed": SEED,
        "voice": {**VOICE, "version": espeak_version()},
        "tempo": {
            "start_bpm": START_BPM,
            "end_bpm": END_BPM,
            "first_beat": round(beats[0] / RATE, 6),
            "law": "bpm(t) = start_bpm + (end_bpm - start_bpm) * (t - first_beat) / (duration - first_beat); beat k where the integral of bpm/60 from first_beat reaches k",
        },
        "beats": seconds(beats),
        "downbeats": seconds(beats[::4]),
        "kicks": seconds(kicks),
        "snares": seconds(snares),
        "hats": seconds(hats),
        "sections": [
            {"name": s["name"], "cue": s["cue"], "start": bounds[i], "end": bounds[i + 1]} for i, s in enumerate(sections)
        ],
        "lines": line_truth,
        "words": words,
    }
    (out / "truth.json").write_text(json.dumps(truth, indent=2) + "\n", encoding="utf-8")
    return truth


def main(argv) -> int:
    parser = argparse.ArgumentParser(description="Build the synthetic test song.")
    parser.add_argument("--out", required=True)
    parser.add_argument("--lyrics", help="a lyric sheet of two [sections] of lower-case words; display.txt then capitalises each line")
    args = parser.parse_args(argv)
    lyrics, display = LYRICS, DISPLAY
    if args.lyrics:
        lyrics = Path(args.lyrics).read_text(encoding="utf-8")
        _, lines = parse_sheet(lyrics)
        display = "".join(l["text"][:1].upper() + l["text"][1:] + "\n" for l in lines)
    truth = build(Path(args.out), lyrics, display)
    print(f"synthetic song: {len(truth['words'])} words, {len(truth['beats'])} beats, {truth['duration']} s")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
