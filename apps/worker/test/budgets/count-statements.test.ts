import { beforeAll, describe, expect, it } from "vitest";
import { applyMigrationsOnce, e } from "../support/app.ts";
import { countingD1 } from "../support/count-statements.ts";

// The budgets are only as good as the counter, so the counter is tested on its
// own against the real D1 of the test pool.

beforeAll(applyMigrationsOnce);

describe("countingD1", () => {
  it("counts each executed statement once, whichever method runs it", async () => {
    const { d1, count } = countingD1(e.DB);
    const stmt = d1.prepare("SELECT ? AS n").bind(7);
    expect((await stmt.first<{ n: number }>())?.n).toBe(7);
    expect((await stmt.all<{ n: number }>()).results[0]?.n).toBe(7);
    expect((await stmt.raw())[0]).toEqual([7]);
    await d1.prepare("SELECT 1").run();
    expect(count.statements).toBe(4);
    expect(count.sql).toEqual(["SELECT ? AS n", "SELECT ? AS n", "SELECT ? AS n", "SELECT 1"]);
  });

  it("does not count a statement that is prepared or bound but never run", () => {
    const { d1, count } = countingD1(e.DB);
    d1.prepare("SELECT 1");
    d1.prepare("SELECT ?").bind(1);
    expect(count.statements).toBe(0);
  });

  it("counts every statement in a batch and still runs them all", async () => {
    const { d1, count } = countingD1(e.DB);
    const results = await d1.batch<{ n: number }>([
      d1.prepare("SELECT ? AS n").bind(1),
      d1.prepare("SELECT ? AS n").bind(2),
      d1.prepare("SELECT 3 AS n"),
    ]);
    expect(results.map((r) => r.results[0]?.n)).toEqual([1, 2, 3]);
    expect(count.statements).toBe(3);
  });

  it("counts each line passed to exec", async () => {
    const { d1, count } = countingD1(e.DB);
    await d1.exec("SELECT 1\nSELECT 2\n");
    expect(count.statements).toBe(2);
  });

  it("refuses the D1 calls it cannot count", () => {
    const { d1 } = countingD1(e.DB);
    expect(() => d1.withSession()).toThrow(/does not count D1Database\.withSession/);
    expect(() => d1.dump()).toThrow(/does not count D1Database\.dump/);
  });
});
