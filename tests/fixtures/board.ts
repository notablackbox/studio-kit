import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kitRoot, tempDir } from "./film.ts";

// The board tests' fixture: tests/fixtures/board/ (shots.json over the synthetic song, the
// analysis the listening commands made from it, three clip files, three plates, a walk report
// and a recordings list) copied into a fresh folder, and a way to write changed boards there.

export const boardFixture = join(kitRoot, "tests", "fixtures", "board");

export type AnyBoard = {
  version: number;
  duration: number;
  chapters: Record<string, unknown>[];
  shots: Record<string, unknown>[];
  plates: Record<string, unknown>[];
};

export function boardDir(): string {
  const dir = tempDir("board");
  cpSync(boardFixture, dir, { recursive: true });
  return dir;
}

export function readBoardFile(dir: string, name = "shots.json"): AnyBoard {
  return JSON.parse(readFileSync(join(dir, name), "utf8"));
}

// Writes `name` in `dir`: the fixture board changed by `change`, which gets the shots by id.
export function changedBoard(dir: string, name: string, change: (board: AnyBoard, shot: (id: string) => Record<string, unknown>) => void): string {
  const board = readBoardFile(dir);
  const shot = (id: string) => {
    const found = board.shots.find((s) => s.id === id);
    if (!found) throw new Error(`no shot ${id}`);
    return found;
  };
  change(board, shot);
  writeFileSync(join(dir, name), JSON.stringify(board, null, 2) + "\n");
  return name;
}
