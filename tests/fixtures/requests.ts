import { createHash } from "node:crypto";
import { join } from "node:path";
import { kitRoot } from "./film.ts";

// The request tests' fixture: tests/fixtures/requests/ (a motion clip, an image slot, and the
// recorded call_external inputs and their meta files), and the idempotency key computed by
// the tests' own canonical JSON, written apart from the kit's.

export const requestsFixture = join(kitRoot, "tests", "fixtures", "requests");

function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export const keyOf = (provider: string, model: string, body: unknown, attempt: number) =>
  createHash("sha256").update(canon({ attempt, body, model, provider })).digest("hex");
