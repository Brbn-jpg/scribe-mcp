import assert from "node:assert/strict";
import { test } from "node:test";
import { ARTBOARD, DETAIL_BUDGET, paintImage } from "./painter.ts";
import { sampleImage } from "./test-images.ts";

test("paints a photo within budget, inside the artboard, faithfully", () => {
  const painting = paintImage(sampleImage(), { detail: "low" });
  assert.equal(painting.aspect, "landscape"); // 4:3 is closer to 16:9 than to 1:1
  assert.deepEqual([painting.width, painting.height], ARTBOARD.landscape);
  assert.ok(painting.strokes.length <= DETAIL_BUDGET.low);
  assert.ok(painting.underpaintStrokes > 0 && painting.underpaintStrokes < painting.strokes.length);
  for (const s of painting.strokes) {
    assert.match(s.color, /^#[0-9a-f]{6}$/);
    assert.ok(s.pts.length >= 2);
    for (const [x, y] of s.pts) assert.ok(x >= 0 && x <= painting.width && y >= 0 && y <= painting.height);
  }
  assert.ok(painting.meanAbsDiff < 0.06, `mean abs diff ${painting.meanAbsDiff}`);
});

test("is deterministic and honours aspect and pen", () => {
  const a = paintImage(sampleImage(), { detail: "low", aspect: "portrait", pen: "marker" });
  const b = paintImage(sampleImage(), { detail: "low", aspect: "portrait", pen: "marker" });
  assert.deepEqual(a.strokes, b.strokes);
  assert.deepEqual([a.width, a.height], ARTBOARD.portrait);
});

test("more detail lowers the error", () => {
  const low = paintImage(sampleImage(), { detail: "low" });
  const high = paintImage(sampleImage(), { detail: "high" });
  assert.ok(high.meanAbsDiff <= low.meanAbsDiff);
});
