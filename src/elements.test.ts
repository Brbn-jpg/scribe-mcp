import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyUpdate,
  buildConnector,
  buildDrawStrokes,
  buildElement,
  contentBounds,
  ElementError,
  summarizeBoard,
  SPEC_TYPES,
  validateElement,
  type Json,
} from "./elements.ts";

let counter = 0;
const ctx = { newId: () => `id-${++counter}` };

test("builds every type with the UI defaults", () => {
  const rect = buildElement({ type: "rect", x: 10, y: 20 }, ctx);
  assert.deepEqual({ ...rect, id: "x" }, { id: "x", type: "rect", x: 10, y: 20, w: 180, h: 96, stroke: "#1d3fbf", strokeWidth: 3 });
  assert.equal(buildElement({ type: "ellipse" }, ctx).type, "ellipse");
  assert.equal(buildElement({ type: "poly" }, ctx).kind, "triangle");
  assert.equal(buildElement({ type: "poly", kind: "star", fill: "#ffd666" }, ctx).fill, "#ffd666");

  const box = buildElement({ type: "box", label: "API" }, ctx);
  assert.equal(box.fontFamily, "archivo");
  assert.equal(box.fontSize, 18);
  assert.equal(box.textColor, "#23211c");
  assert.equal(box.w, 180);

  const sticky = buildElement({ type: "sticky", text: "Idea" }, ctx);
  assert.equal(sticky.fill, "#ffd666");
  assert.equal(sticky.textColor, "#23211c");
  assert.equal(sticky.w, 180);
  assert.equal(sticky.h, 180);
  assert.equal(sticky.label, "Idea");

  const text = buildElement({ type: "text", text: "Hello", x: 1, y: 2 }, ctx);
  assert.equal(text.fontSize, 18);
  assert.equal(text.color, "#23211c");
  assert.equal(text.bold, false);

  const line = buildElement({ type: "line", points: [0, 0, 100, 0] }, ctx);
  assert.equal(line.width, 3);
  assert.equal(buildElement({ type: "arrow", points: [0, 0, 0, 80], dash: "dash" }, ctx).dash, "dash");

  const table = buildElement({ type: "table" }, ctx);
  assert.equal((table.cells as string[][]).length, 3);
  assert.deepEqual(table.colWidths, [96, 96, 96]);
  assert.equal(table.w, 32 + 288);
  assert.equal(table.h, 24 + 3 * 38.5);

  const uml = buildElement({ type: "umlClass", name: "User", attributes: ["- id"], methods: ["+ save()"] }, ctx);
  assert.equal(uml.w, 240);
  assert.equal(uml.h, 36 + 28 + 28);
  assert.equal(buildElement({ type: "umlClass" }, ctx).name, "Class");
});

test("every spec type is covered by a builder", () => {
  const samples: Record<string, Json> = {
    rect: {}, ellipse: {}, poly: {}, box: {}, sticky: {}, text: { text: "t" },
    line: { points: [0, 0, 5, 5] }, arrow: { points: [0, 0, 5, 5] }, table: {}, umlClass: {},
  };
  for (const type of SPEC_TYPES) assert.equal(buildElement({ type, ...samples[type] } as never, ctx).type, type);
});

test("dark boards get light ink and text", () => {
  const dark = { ...ctx, background: "#000000" };
  assert.equal(buildElement({ type: "rect" }, dark).stroke, "#ffffff");
  assert.equal(buildElement({ type: "text", text: "x" }, dark).color, "#ffffff");
  assert.equal(buildElement({ type: "box" }, dark).textColor, "#ffffff");
  assert.equal(buildElement({ type: "sticky" }, dark).textColor, "#23211c");
});

test("boxes, notes, classes and tables grow to fit their content", () => {
  const box = buildElement({ type: "box", label: "a very long label that cannot fit in a default box at all", width: 130 }, ctx);
  assert.ok((box.w as number) > 130);
  const note = buildElement({ type: "sticky", text: "word ".repeat(80) }, ctx);
  assert.ok((note.h as number) > 180);
  const uml = buildElement({ type: "umlClass", name: "N", attributes: Array.from({ length: 6 }, (_, i) => `- field${i}`) }, ctx);
  assert.equal(uml.h, 36 + 6 * 28 + 28);
  const table = buildElement({ type: "table", cells: [["a", "b"], ["c"]], colWidths: [100] }, ctx);
  assert.deepEqual(table.cells, [["a", "b"], ["c", ""]]);
  assert.deepEqual(table.colWidths, [100, 96]);
});

test("small sizes are lifted to the element minimum", () => {
  const box = buildElement({ type: "box", width: 5, height: 5 }, ctx);
  assert.equal(box.w, 120);
  assert.equal(box.h, 64);
  assert.equal(buildElement({ type: "sticky", width: 10, height: 10 }, ctx).w, 120);
  assert.equal(buildElement({ type: "umlClass", width: 20 }, ctx).w, 160);
});

test("rejects anything that could break the canvas", () => {
  const bad: Json[] = [
    { type: "rect", x: Number.NaN },
    { type: "rect", x: Infinity },
    { type: "rect", width: 0 },
    { type: "rect", height: -4 },
    { type: "rect", width: 1e9 },
    { type: "rect", x: 1e9 },
    { type: "rect", stroke: "red" },
    { type: "rect", dash: "wavy" },
    { type: "poly", kind: "octagon" },
    { type: "text", text: "   " },
    { type: "text", text: "x", fontFamily: "comic" },
    { type: "line", points: [0, 0, 0, 0] },
    { type: "line", points: [0, 0, 1] },
    { type: "table", rows: 0 },
    { type: "table", columns: 99 },
    { type: "table", cells: [] },
    { type: "mystery" },
  ];
  for (const spec of bad) assert.throws(() => buildElement(spec as never, ctx), ElementError, JSON.stringify(spec));
});

test("clamps stroke width and font size into a safe range", () => {
  assert.equal(buildElement({ type: "rect", strokeWidth: 0.01 }, ctx).strokeWidth, 1);
  assert.equal(buildElement({ type: "text", text: "x", fontSize: 1 }, ctx).fontSize, 6);
});

test("validateElement is the last line of defence", () => {
  assert.throws(() => validateElement({ id: "", type: "rect", w: 1, h: 1 }));
  assert.throws(() => validateElement({ id: "a", type: "rect", x: 0, y: 0, w: 0.4, h: 10 }));
  assert.throws(() => validateElement({ id: "a", type: "stroke", points: [0, 0, Number.NaN, 1] }));
  assert.throws(() => validateElement({ id: "a", type: "stroke", points: [0, 0, 1] }));
  assert.throws(() => validateElement({ id: "a", type: "table", w: 5, h: 5, colWidths: [0], cells: [[""]] }));
});

test("connectors default to facing ports and carry no label", () => {
  const a = buildElement({ type: "box", x: 0, y: 0 }, ctx);
  const b = buildElement({ type: "box", x: 400, y: 0 }, ctx);
  const c = buildElement({ type: "box", x: 0, y: 300 }, ctx);
  const rect = buildElement({ type: "rect" }, ctx);
  const byId = new Map<string, Json>([a, b, c, rect].map((e) => [e.id, e]));
  const { connector } = buildConnector({ from: a.id, to: b.id, relation: "dependency" }, byId, ctx);
  assert.deepEqual(connector.source, { nodeId: a.id, port: "right" });
  assert.deepEqual(connector.target, { nodeId: b.id, port: "left" });
  assert.equal(connector.routing, "orthogonal");
  assert.equal(connector.relation, "dependency");
  const down = buildConnector({ from: a.id, to: c.id }, byId, ctx).connector;
  assert.deepEqual(down.source, { nodeId: a.id, port: "bottom" });
  assert.deepEqual(down.target, { nodeId: c.id, port: "top" });
  const free = buildConnector({ from: a.id, to: { x: 700, y: 50 }, fromPort: "right" }, byId, ctx).connector;
  assert.deepEqual(free.target, { x: 700, y: 50 });
  assert.throws(() => buildConnector({ from: a.id, to: "nope" }, byId, ctx), /not an element/);
  assert.throws(() => buildConnector({ from: a.id, to: rect.id }, byId, ctx), /only to box, sticky and umlClass/);
  assert.throws(() => buildConnector({ from: a.id, to: a.id }, byId, ctx), /two different ends/);
});

test("board_draw placement scales the path into the requested box", () => {
  const strokes = buildDrawStrokes([{ d: "M0 0 L 100 0 L 100 50 L 0 50 Z", color: "#ff0000", width: 4 }], { x: 500, y: 200, width: 200 }, ctx);
  assert.equal(strokes.length, 1);
  const box = contentBounds(strokes)!;
  assert.equal(Math.round(box.x), 500);
  assert.equal(Math.round(box.y), 200);
  assert.equal(Math.round(box.w), 200);
  assert.equal(Math.round(box.h), 100);
  assert.equal(strokes[0]!.color, "#ff0000");
  assert.equal(strokes[0]!.width, 4);
  for (const s of strokes) validateElement(s);
});

test("board_draw smooths curves at the final size and caps points", () => {
  const strokes = buildDrawStrokes([{ d: "M0 0 C 10 100 90 100 100 0" }], { width: 600 }, ctx);
  assert.ok((strokes[0]!.points as number[]).length > 20);
  const long = buildDrawStrokes([{ d: `M0 0 ${Array.from({ length: 5000 }, (_, i) => `L ${i} ${i % 7}`).join(" ")}` }], { width: 300 }, ctx);
  assert.ok((long[0]!.points as number[]).length <= 4000);
});

test("board_draw rejects bad path data and degenerate drawings", () => {
  assert.throws(() => buildDrawStrokes([{ d: "M 0 0 L 1e999 0" }], {}, ctx), ElementError);
  assert.throws(() => buildDrawStrokes([{ d: "hello" }], {}, ctx), ElementError);
  assert.throws(() => buildDrawStrokes([{ d: "M 5 5" }], {}, ctx), /single point|too small|no drawable/);
  assert.throws(() => buildDrawStrokes([{ d: "M0 0 L 10 10", color: "blue" }], {}, ctx), /hex colour/);
  assert.throws(() => buildDrawStrokes([], {}, ctx), ElementError);
});

test("applyUpdate merges into the full element", () => {
  const box = buildElement({ type: "box", label: "Old", x: 10, y: 10, fill: "#ffd666", dash: "dash" }, ctx);
  const next = applyUpdate(box, { id: box.id, label: "New", x: 99, fill: null, dash: null }, ctx);
  assert.equal(next.id, box.id);
  assert.equal(next.label, "New");
  assert.equal(next.x, 99);
  assert.equal(next.y, 10);
  assert.equal("fill" in next, false);
  assert.equal("dash" in next, false);
  assert.equal(next.stroke, box.stroke);
  assert.equal(next.fontFamily, box.fontFamily);

  const sticky = buildElement({ type: "sticky", text: "a" }, ctx);
  assert.equal(applyUpdate(sticky, { id: sticky.id, label: "b" }, ctx).label, "b");
  const text = buildElement({ type: "text", text: "a", bold: true }, ctx);
  const moved = applyUpdate(text, { id: text.id, y: 40 }, ctx);
  assert.equal(moved.bold, true);
  assert.equal(moved.y, 40);
  const table = buildElement({ type: "table", cells: [["a"]] }, ctx);
  assert.deepEqual(applyUpdate(table, { id: table.id, cells: [["a", "b"], ["c", "d"]] }, ctx).colWidths, [96, 96]);
});

test("applyUpdate rejects what cannot be edited", () => {
  const box = buildElement({ type: "box" }, ctx);
  assert.throws(() => applyUpdate(box, { id: box.id, type: "rect" }, ctx), /cannot change/);
  assert.throws(() => applyUpdate(box, { id: box.id, width: 0 }, ctx), ElementError);
  assert.throws(() => applyUpdate(box, { id: box.id, colour: "#fff" }, ctx), /cannot change colour/);
  assert.throws(() => applyUpdate({ id: "i", type: "image", url: "u", x: 0, y: 0, w: 1, h: 1 }, { id: "i", x: 3 }, ctx), /cannot be edited/);
  const stroke = { id: "s", type: "stroke", points: [0, 0, 5, 5], color: "#000000", width: 2 };
  assert.equal(applyUpdate(stroke, { id: "s", color: "#ff0000" }, ctx).color, "#ff0000");
  assert.throws(() => applyUpdate(stroke, { id: "s", points: [] }, ctx), /can change only/);
  const a = buildElement({ type: "box" }, ctx);
  const b = buildElement({ type: "box", x: 300 }, ctx);
  const { connector } = buildConnector({ from: a.id, to: b.id }, new Map<string, Json>([[a.id, a], [b.id, b]]), ctx);
  const changed = applyUpdate(connector, { id: connector.id, relation: "inheritance", fromPort: "top" }, ctx);
  assert.equal(changed.relation, "inheritance");
  assert.deepEqual(changed.source, { nodeId: a.id, port: "top" });
});

test("summarizeBoard lists elements, text, colours, connector ends and bounds", () => {
  const a = buildElement({ type: "box", label: "Web", x: 0, y: 0 }, ctx);
  const b = buildElement({ type: "sticky", text: "Note", x: 400, y: 0 }, ctx);
  const t = buildElement({ type: "table", cells: [["Name", "Qty"], ["x", "1"]], x: 0, y: 300 }, ctx);
  const u = buildElement({ type: "umlClass", name: "User", x: 700, y: 0 }, ctx);
  const { connector } = buildConnector({ from: a.id, to: b.id }, new Map<string, Json>([[a.id, a], [b.id, b]]), ctx);
  const text = summarizeBoard({ id: "bid", title: "Plan", live: true, scene: { version: 1, background: "#ffffff", elements: [a, b, t, u, connector] } });
  assert.match(text, /5 elements, live/);
  assert.match(text, new RegExp(`${a.id} box \\| x=0 y=0 w=180 h=96 \\| "Web" \\| stroke #1d3fbf`));
  assert.match(text, /"Name \| Qty"/);
  assert.match(text, /"User"/);
  assert.match(text, new RegExp(`${connector.id} connector \\| ${a.id}\\.right -> ${b.id}\\.left`));
  assert.match(text, /Content bounds: x 0\.\.940/);
  assert.match(summarizeBoard({ scene: null }), /board is empty/);
});
