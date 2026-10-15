"""The lyric files' one parser (claudia.gallery's formats wiki).

Blank lines are skipped; a line starting with `[` is a tag (a section cue or a note) and is
skipped too. The Nth remaining line of display.txt shows the Nth remaining line of lyrics.txt.
A sung word is a whitespace token of a lyric line with at least one letter or digit once
romanised; digits are spelled out for the aligner. `TEXT|n` in display.txt shows TEXT over the
next n sung words (n defaults to 1, `|0` rides on the next token).
"""

import re
import unicodedata

ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split()
TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()
SYMBOLS = {"&": "and", "%": "percent", "+": "plus", "@": "at", "=": "equals"}


def spell(number: int) -> str:
    """A whole number in words, as it is sung ("125" is "one hundred twenty five")."""
    if number < 20:
        return ONES[number]
    if number < 100:
        return TENS[number // 10] + ("" if number % 10 == 0 else " " + ONES[number % 10])
    if number < 1000:
        rest = number % 100
        return ONES[number // 100] + " hundred" + ("" if rest == 0 else " " + spell(rest))
    if number < 1_000_000:
        rest = number % 1000
        return spell(number // 1000) + " thousand" + ("" if rest == 0 else " " + spell(rest))
    return " ".join(ONES[int(d)] for d in str(number))


def romanised(token: str) -> str:
    """The token as the aligner reads it: ASCII letters a-z and apostrophes, digits spelled out."""
    text = unicodedata.normalize("NFKD", token)
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = "".join(SYMBOLS.get(c, c) for c in text).lower()
    text = re.sub(r"[0-9]+", lambda m: " " + spell(int(m.group(0))) + " ", text)
    text = text.replace("’", "'")
    return " ".join(re.findall(r"[a-z]+(?:'[a-z]+)*", text))


def tag_name(tag: str) -> str:
    """The section name of a cue: `[Verse 1 - spoken, deadpan]` is "Verse 1"."""
    inner = tag.strip()[1:].rstrip("]").strip()
    return re.split(r"\s+-\s+|:", inner, maxsplit=1)[0].strip() or "section"


def parse(text: str):
    """The sheet: its lines (text, words, section) and its sections (name, first line index).

    A word is {"w": romanised text for the aligner, "token": the sheet's token, "acronym": bool}.
    """
    lines, sections = [], []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("["):
            if line.endswith("]"):
                sections.append({"name": tag_name(line), "tag": line, "first_line": len(lines)})
            continue
        words = []
        for token in line.split():
            spoken = romanised(token)
            if not spoken:
                continue
            acronym = bool(re.fullmatch(r"[A-Z]{2,6}", token.strip(".,;:!?\"'()")))
            words.append({"w": spoken.replace(" ", ""), "token": token, "acronym": acronym})
        lines.append({"text": line, "words": words, "section": len(sections) - 1})
    return lines, sections


def display_counts(text: str):
    """Each display line with the number of sung words it consumes, or a problem for the line."""
    result = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("["):
            continue
        count = 0
        for token in line.split():
            match = re.search(r"\|(\d+)$", token)
            count += int(match.group(1)) if match else 1
        result.append((line, count))
    return result
