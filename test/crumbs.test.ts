/** Our own rider breadcrumbs (src/tracking/crumbs.ts, ROUTE-11). Pure: no Redis, no OSRM. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendCrumb, crumbsToPath, isoToUnixSeconds, type CrumbsEntry } from "../src/tracking/crumbs.js";

const opts = { minMoveM: 10, maxPoints: 3 };
const p = (i: number) => ({ lat: 28.43 + i * 0.001, lng: 77.04 }); // ~111 m apart

describe("appendCrumb", () => {
  it("numbers crumbs 1, 2, 3 ... starting from no entry", () => {
    let e: CrumbsEntry | null = null;
    for (let i = 0; i < 3; i++) e = appendCrumb(e, p(i), 1000 + i * 15, opts).entry;
    assert.deepEqual(e!.points.map((c) => c.seq), [1, 2, 3]);
    assert.equal(e!.next_seq, 4);
  });

  it("skips an older timestamp and a point that didn't move, and returns the entry unchanged", () => {
    const first = appendCrumb(null, p(0), 1000, opts).entry;
    const older = appendCrumb(first, p(1), 999, opts);
    assert.equal(older.skipped, "older");
    assert.equal(older.entry, first);
    const still = appendCrumb(first, { lat: 28.43002, lng: 77.04 }, 1015, opts); // ~2 m
    assert.equal(still.skipped, "not_moved");
    assert.equal(still.entry, first);
  });

  it("same timestamp but moved: stored 1 s after the last crumb (timestamps stay increasing for /match)", () => {
    const first = appendCrumb(null, p(0), 1000, opts).entry;
    const { entry, skipped } = appendCrumb(first, p(1), 1000, opts);
    assert.equal(skipped, undefined);
    assert.deepEqual(entry.points.map((c) => c.t), [1000, 1001]);
  });

  it("keeps only the newest maxPoints, but keeps counting", () => {
    let e: CrumbsEntry | null = null;
    for (let i = 0; i < 5; i++) e = appendCrumb(e, p(i), 1000 + i * 15, opts).entry;
    assert.deepEqual(e!.points.map((c) => c.seq), [3, 4, 5]);
    assert.equal(e!.next_seq, 6);
  });

  it("crumbsToPath keeps lat/lng (no swap), our sequence and the time", () => {
    const e = appendCrumb(null, { lat: 28.4977, lng: 77.0888 }, 1_793_500_000, opts).entry;
    assert.deepEqual(crumbsToPath(e), [{ point: { lat: 28.4977, lng: 77.0888 }, sequence: 1, unixSeconds: 1_793_500_000 }]);
  });
});

describe("isoToUnixSeconds", () => {
  it("parses ISO 8601, undefined for missing or garbage", () => {
    assert.equal(isoToUnixSeconds("2026-11-10T05:30:32.866Z"), Math.floor(Date.parse("2026-11-10T05:30:32.866Z") / 1000));
    assert.equal(isoToUnixSeconds(undefined), undefined);
    assert.equal(isoToUnixSeconds("not a date"), undefined);
  });
});
