// TEST ONLY. The one deliberate breach of "no state between frames" in the chapter engine, so
// the history check can be shown to fail: drawn only when film:history runs with --test-leak,
// which it accepts only under FILM_TEST=1. It remembers every frame this page has drawn and
// paints a white square in the corner when it has drawn another frame before this one. Frame
// B alone shows no square; frame B after frame A in the same page does.

const seen = new Set<number>();

export function LeakProbe({ frame, color }: { frame: number; color: string }) {
  const before = [...seen].some((f) => f !== frame);
  seen.add(frame);
  if (!before) return null;
  return <div style={{ position: "absolute", left: 0, top: 0, width: 96, height: 96, backgroundColor: color }} />;
}
