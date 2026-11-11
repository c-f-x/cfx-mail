import { describe, expect, it } from "vitest";
import { atHour, combineDateTime, isBeforeDay } from "./time.ts";

// The schedule and reminder pickers stamp a wall-clock time onto a day, in the
// user's own time zone.

describe("combineDateTime", () => {
  it("puts an HH:mm time on the given day, seconds cleared", () => {
    const day = new Date(2026, 9, 9, 23, 59, 59, 999);
    expect(combineDateTime(day, "07:05")).toEqual(new Date(2026, 9, 9, 7, 5, 0, 0));
  });

  it("reads a missing part as zero", () => {
    expect(combineDateTime(new Date(2026, 9, 9, 15), "8")).toEqual(new Date(2026, 9, 9, 8, 0));
  });

  it("leaves the day it was given alone", () => {
    const day = new Date(2026, 9, 9, 15);
    combineDateTime(day, "07:05");
    expect(day).toEqual(new Date(2026, 9, 9, 15));
  });
});

describe("atHour", () => {
  it("moves to the start of the hour on the same day", () => {
    expect(atHour(new Date(2026, 9, 9, 15, 42, 7), 18)).toEqual(new Date(2026, 9, 9, 18, 0, 0, 0));
  });
});

describe("isBeforeDay", () => {
  const now = new Date(2026, 9, 9, 15, 42);

  it("rules out days before today", () => {
    expect(isBeforeDay(new Date(2026, 9, 8), now)).toBe(true);
  });

  it("keeps today, even after its midnight has passed", () => {
    expect(isBeforeDay(new Date(2026, 9, 9), now)).toBe(false);
  });

  it("keeps later days", () => {
    expect(isBeforeDay(new Date(2026, 9, 10), now)).toBe(false);
  });
});
