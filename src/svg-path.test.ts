import assert from "node:assert/strict";
import { test } from "node:test";
import { PathError, pathToPolylines } from "./svg-path.ts";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("lines, implicit lineto, H/V and closepath", () => {
  const [line] = pathToPolylines("M0 0 10 0 V10 H0 Z", 1);
  assert.deepEqual(line, [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]);
});

test("relative commands and separate subpaths", () => {
  const lines = pathToPolylines("m1 1 l2 0 m5 5 l0 2", 1);
  assert.deepEqual(lines, [[[1, 1], [3, 1]], [[8, 6], [8, 8]]]);
});

test("cubic and quadratic curves end on their endpoints and are flattened", () => {
  const [cubic] = pathToPolylines("M0 0 C 0 10 10 10 10 0", 0.5);
  assert.ok(cubic!.length > 10);
  assert.deepEqual(cubic!.at(-1), [10, 0]);
  const [smooth] = pathToPolylines("M0 0 Q 5 10 10 0 T 20 0", 0.5);
  assert.deepEqual(smooth!.at(-1), [20, 0]);
  // T reflects the control point, so the second hump dips below the axis
  assert.ok(smooth!.some(([, y]) => y < -1));
});

test("arcs trace a circle, including packed flags", () => {
  const [circle] = pathToPolylines("M10 10a10 10 0 1020 0 10 10 0 10-20 0z", 0.2);
  for (const [x, y] of circle!) close(Math.hypot(x - 20, y - 10), 10, 1e-6);
  // both halves: the path reaches the top and the bottom of the circle
  assert.ok(circle!.some(([, y]) => y < 0.1) && circle!.some(([, y]) => y > 19.9));
});

test("rejects malformed data with a readable message", () => {
  assert.throws(() => pathToPolylines("10 10", 1), PathError);
  assert.throws(() => pathToPolylines("M0 0 L", 1), /missing arguments/);
  assert.throws(() => pathToPolylines("M0 0 X 5", 1), PathError);
});
