"""The lyric scorer behind film:score.

    python3 -I -m film_py.score <lyrics.txt>

Follows claudia.gallery's song wiki (/wiki/song, /wiki/toolkit section 2): syllables and
stress per word from the CMU pronouncing dictionary (the `cmudict` package, which bundles it),
a letter-group fallback for words it lacks, a scansion score per line and section, an
assonance score per line and section, and a lint. The scores are a diagnostic, 0 to 100; the
director's ear decides.

The scansion model, after the wiki's measured delivery: a spoken line gets its own two-bar
slot, entering on the "and" of beat 2 and landing its last word on beat 4 of bar 2. The line's
syllables are spread evenly over that slot (sixteenths 6 to 28), and the score weighs:
- grid (0.35): stressed syllables landing within a sixteenth of a beat;
- spacing (0.25): no two primary stresses side by side, no run of four weak syllables;
- length (0.25): the syllable count inside the delivery's range (spoken 10 to 13, sung 4 to
  10, chant 4 to 8), losing 0.15 per syllable outside it;
- shape (0.15): at most two phrases between full stops, and no one-word fragment mid-line.
Groove (for chants) is not modelled apart; the wiki keeps it off verses.

Assonance: each line end's best partner within four lines, a rhyme (1.0), a slant rhyme on
the same stressed vowel (0.6) or the same final consonants (0.3); plus the echo of stressed
vowels inside the line, weighted 0.8 and 0.2.
"""

import re
import sys

from film_py import done, refuse, shown

CUE = re.compile(r"^\s*\[(.*)\]\s*$")
TOKEN = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)*|[0-9]+")
VOWEL_GROUP = re.compile(r"[aeiouy]+")

FUNCTION_WORDS = frozenset(
    """a an the and but or nor so yet of to in on at by for from with as into onto upon off out up
    is am are was were be been being do does did has have had will would shall should can could may
    might must i me my we us our you your he him his she her it its they them their this that these
    those who whom whose which what than then if when while there here not no""".split()
)

# Syllables of each digit's name, for a number written in digits (which the lint flags).
DIGIT_SYLLABLES = {"0": 2, "1": 1, "2": 1, "3": 1, "4": 1, "5": 1, "6": 1, "7": 2, "8": 1, "9": 1}

TARGETS = {"spoken": (10, 13), "sung": (4, 10), "chant": (4, 8), "unknown": (6, 13)}

SLOT_START, SLOT_END = 6, 28  # sixteenths: the "and" of beat 2 to beat 4 of bar 2
MAX_SHEET = 3000  # characters Suno takes before it rushes or truncates


def load_dictionary():
    try:
        import cmudict  # noqa: PLC0415
    except ImportError:
        refuse(["the cmudict dictionary is not installed (pip install -r src/film/py/requirements.txt)"])
    return cmudict.dict()


SPOKEN_WORDS = frozenset("spoken spoke speak speaks speaking rap raps rapped rapping".split())
CHANT_WORDS = frozenset("chant chants chanted chanting shout shouts shouted shouting".split())
SUNG_WORDS = frozenset("sung sing sings singing".split())


def delivery_of(cue: str, name: str) -> str:
    """The delivery a cue names, by whole words ("rising" is not "sing", "rap," is "rap")."""
    words = set(re.findall(r"[a-z]+", cue.lower()))
    if words & SPOKEN_WORDS:
        return "spoken"
    if words & CHANT_WORDS:
        return "chant"
    if words & SUNG_WORDS:
        return "sung"
    return "spoken" if name.lower().startswith("verse") else "sung"


def parse_sheet(text: str):
    """Sections in order, each with its lyric lines (file line number, text); cues skipped."""
    sections = []
    current = None
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.strip()
        if not line:
            continue
        cue = CUE.match(line)
        if cue:
            inner = cue.group(1).strip()
            name = re.split(r"\s+-\s+|:", inner, maxsplit=1)[0].strip() or inner
            current = {"name": name, "cue": line, "delivery": delivery_of(inner, name), "lines": []}
            sections.append(current)
            continue
        if current is None:
            current = {"name": "", "cue": None, "delivery": "unknown", "lines": []}
            sections.append(current)
        current["lines"].append((number, line))
    return [s for s in sections if s["lines"]]


def fallback(lower: str):
    groups = VOWEL_GROUP.findall(lower)
    n = len(groups)
    if n > 1 and lower.endswith("e") and not lower.endswith(("le", "ee", "ye")):
        n -= 1
    n = max(1, n)
    if n == 1:
        return "0" if lower in FUNCTION_WORDS else "1"
    return "1" + "0" * (n - 1)


def is_acronym(token: str) -> bool:
    """Two or more capital letters and nothing else ("AGI"; not "I", not "I'M")."""
    return len(token) >= 2 and token.isalpha() and token.isupper()


def word_info(token: str, dictionary):
    """A word's syllables and stresses: 1 primary, 2 secondary, 0 weak."""
    if token.isdigit():
        n = sum(DIGIT_SYLLABLES[c] for c in token)
        return {"word": token, "syllables": n, "stresses": "1" * n, "source": "digits"}, None
    if is_acronym(token):
        # An acronym is said letter by letter ("A G I"); W is three syllables.
        stresses = "".join("201" if c == "W" else "2" for c in token[:-1]) + ("201" if token[-1] == "W" else "1")
        return {"word": token, "syllables": len(stresses), "stresses": stresses, "source": "letters"}, None
    lower = token.lower()
    if lower in dictionary:
        phones = dictionary[lower][0]
        stresses = "".join(p[-1] for p in phones if p[-1].isdigit())
        if len(stresses) == 1:
            stresses = "0" if lower in FUNCTION_WORDS else "1"
        return {"word": token, "syllables": len(stresses), "stresses": stresses, "source": "cmudict"}, phones
    stresses = fallback(lower)
    return {"word": token, "syllables": len(stresses), "stresses": stresses, "source": "fallback"}, None


def end_sound(token: str, phones):
    """The rhyme part of a line's last word (last stressed vowel to the end), its vowel and coda."""
    if phones:
        bare = [p.rstrip("012") for p in phones]
        vowels = [i for i, p in enumerate(phones) if p[-1].isdigit()]
        stressed = [i for i in vowels if phones[i][-1] in "12"] or vowels or [0]
        at = stressed[-1]
        rhyme = bare[at:]
        coda = tuple(p for p in rhyme[1:])
        return " ".join(rhyme), rhyme[0], coda
    lower = token.lower()
    groups = list(VOWEL_GROUP.finditer(lower))
    if not groups:
        return lower, "", (lower,)
    last = groups[-1]
    if len(groups) > 1 and lower.endswith("e") and last.end() == len(lower):
        last = groups[-2]
    rhyme = lower[last.start():]
    return rhyme, last.group(0), tuple(lower[last.end():])


def scansion(stresses: str, delivery: str, text: str) -> int:
    n = len(stresses)
    if n == 0:
        return 0
    step = (SLOT_END - SLOT_START) / (n - 1) if n > 1 else 0
    positions = [SLOT_START + i * step for i in range(n)] if n > 1 else [SLOT_END]
    important = [i for i, s in enumerate(stresses) if s == "1"]
    if important:
        hits = sum(1 for i in important if abs(positions[i] - 4 * round(positions[i] / 4)) <= 1.0)
        grid = hits / len(important)
    else:
        grid = 0.0

    pileups = sum(1 for a, b in zip(stresses, stresses[1:]) if a == "1" and b == "1")
    lulls = len(re.findall(r"0{4,}", stresses))
    spacing = max(0.0, 1.0 - (pileups + lulls) / max(1.0, n / 4))

    low, high = TARGETS[delivery]
    outside = low - n if n < low else n - high if n > high else 0
    length = max(0.0, 1.0 - 0.15 * outside)

    phrases = [p for p in re.split(r"[.!?]+", text) if TOKEN.search(p)]
    shape = 1.0
    if len(phrases) > 2:
        shape -= 0.5
    if any(len(TOKEN.findall(p)) == 1 for p in phrases[:-1]):
        shape -= 0.5

    return round(100 * (0.35 * grid + 0.25 * spacing + 0.25 * length + 0.15 * max(0.0, shape)))


def pair_score(a, b) -> float:
    (rhyme_a, vowel_a, coda_a, word_a), (rhyme_b, vowel_b, coda_b, word_b) = a, b
    if rhyme_a == rhyme_b:
        return 0.5 if word_a == word_b else 1.0
    if vowel_a and vowel_a == vowel_b:
        return 0.6
    if coda_a and coda_a == coda_b:
        return 0.3
    return 0.0


def score(text: str, dictionary):
    sections = parse_sheet(text)
    if not sections:
        refuse(["lyrics file holds no lyric line"])

    lines = []
    for index, section in enumerate(sections):
        for number, line in section["lines"]:
            tokens = TOKEN.findall(line)
            words, vowels, last_phones = [], [], None
            for token in tokens:
                info, phones = word_info(token, dictionary)
                words.append(info)
                if phones:
                    vowels += [p.rstrip("012") for p in phones if p[-1] == "1"]
                last_phones = phones
            stresses = "".join(w["stresses"] for w in words)
            last = tokens[-1] if tokens else ""
            rhyme, vowel, coda = end_sound(last, last_phones) if tokens else ("", "", ())
            echo = 1.0 - len(set(vowels)) / len(vowels) if vowels else 0.0
            lines.append(
                {
                    "line": number,
                    "section": section["name"],
                    "section_index": index,
                    "delivery": section["delivery"],
                    "text": line,
                    "words": words,
                    "syllables": len(stresses),
                    "stresses": stresses,
                    "scansion": scansion(stresses, section["delivery"], line),
                    "_end": (rhyme, vowel, coda, last.lower()),
                    "_echo": echo,
                }
            )

    for i, line in enumerate(lines):
        best, partner = 0.0, None
        for j in sorted(range(max(0, i - 4), min(len(lines), i + 5)), key=lambda j: (abs(j - i), j)):
            if j == i:
                continue
            value = pair_score(line["_end"], lines[j]["_end"])
            if value > best:
                best, partner = value, lines[j]["line"]
        line["end_sound"] = line["_end"][0]
        line["partner"] = partner
        line["assonance"] = round(100 * min(1.0, 0.8 * best + 0.2 * line["_echo"]))

    lint = []
    if len(text) > MAX_SHEET:
        lint.append({"line": 0, "kind": "length", "message": f"the sheet runs {len(text)} characters; Suno rushes or truncates past about {MAX_SHEET}"})
    for line in lines:
        n = line["line"]
        if line["delivery"] == "spoken" and not 10 <= line["syllables"] <= 13:
            lint.append({"line": n, "kind": "syllables", "message": f"line {n}: spoken line of {line['syllables']} syllables, want 10 to 13"})
        tokens = TOKEN.findall(line["text"])
        for token in dict.fromkeys(t for t in tokens if t.isdigit()):
            lint.append({"line": n, "kind": "digit", "message": f"line {n}: digit in {shown(token)}: spell numbers out"})
        for token in dict.fromkeys(t for t in tokens if is_acronym(t)):
            lint.append({"line": n, "kind": "acronym", "message": f"line {n}: all-caps {shown(token)}: spell an acronym out ({shown(' '.join(token))})"})

    def mean(values):
        return round(sum(values) / len(values)) if values else 0

    section_report = []
    for index, section in enumerate(sections):
        mine = [line for line in lines if line["section_index"] == index]
        section_report.append(
            {
                "name": section["name"],
                "cue": section["cue"],
                "delivery": section["delivery"],
                "lines": [line["line"] for line in mine],
                "scansion": mean([line["scansion"] for line in mine]),
                "assonance": mean([line["assonance"] for line in mine]),
            }
        )
    for line in lines:
        del line["_end"], line["_echo"], line["section_index"]

    return {
        "lines": lines,
        "sections": section_report,
        "scansion": mean([line["scansion"] for line in lines]),
        "assonance": mean([line["assonance"] for line in lines]),
        "lint": lint,
    }


def main(argv) -> int:
    if len(argv) != 1:
        refuse(["film_py.score wants one argument, the lyrics file"])
    try:
        with open(argv[0], "rb") as handle:
            text = handle.read().decode("utf-8", errors="replace")
    except OSError:
        refuse(["lyrics file cannot be read"])
    done(score(text, load_dictionary()))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
