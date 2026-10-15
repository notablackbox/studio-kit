// Text fitting by estimate, shared by the Teaser's cards and the film engine (no React here).

// The largest size, from `max` down to `min` in 4 px steps, at which `text` is estimated to
// take at most `lines` lines of `width` px. The estimate wraps word by word with generous
// per-character advances for Inter SemiBold (capitals and W or M wider than lower case), so
// the real text takes no more lines than counted. The type never goes below `min`: text that
// still needs more lines there takes the lines it needs, and is never cut.
const SPACE_EM = 0.28;

export function advanceEm(char: string): number {
  if ("WMwm@%".includes(char)) return 0.95;
  if ("iljtfrI.,:;!|'()[]-/ ".includes(char)) return 0.36;
  if (/[A-Z]/.test(char)) return 0.74;
  if (/[0-9]/.test(char)) return 0.64;
  if (/[a-z]/.test(char)) return 0.58;
  return 1.0;
}

export function fitFontSize(text: string, max: number, min: number, width: number, lines: number): number {
  return fitText(text, max, min, width, lines).size;
}

// The same fit, with the number of lines the text is estimated to take at that size.
export function fitText(
  text: string,
  max: number,
  min: number,
  width: number,
  lines: number,
): { size: number; lines: number } {
  const words = text.trim().split(/\s+/).map((word) => [...word].map(advanceEm));
  for (let size = max; size > min; size -= 4) {
    const taken = linesAt(words, width / size);
    if (taken <= lines) return { size, lines: taken };
  }
  return { size: min, lines: linesAt(words, width / min) };
}

// Lines a run of words takes on a line `room` em wide; a word wider than the line breaks anywhere.
function linesAt(words: number[][], room: number): number {
  let count = 1;
  let used = 0;
  for (const word of words) {
    const wordEm = word.reduce((sum, em) => sum + em, 0);
    if (used > 0 && used + SPACE_EM + wordEm <= room) {
      used += SPACE_EM + wordEm;
      continue;
    }
    if (used > 0) count += 1;
    used = 0;
    for (const em of word) {
      if (used > 0 && used + em > room) {
        count += 1;
        used = 0;
      }
      used += em;
    }
  }
  return count;
}
