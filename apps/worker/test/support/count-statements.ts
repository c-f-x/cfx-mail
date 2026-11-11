// Counts the SQL statements a piece of code sends to D1.
//
// `countingD1(real)` returns a D1Database that forwards everything to `real`
// and counts every statement that is executed:
//   - one for each run/all/first/raw on a prepared statement,
//   - one for each statement inside a batch (a batch is one round trip, but it
//     is still that many statements of work for D1),
//   - one for each line passed to exec.
// Statements that are prepared or bound but never executed are not counted.
//
// The count is exact and the same on every run, so a test can budget it.
// Drizzle, Better Auth and the raw `env.DB.prepare` calls all go through
// `prepare` and `batch`, so they are all counted. `withSession` and `dump` are
// not used by the Worker; they throw here so that a later use cannot go
// uncounted without anyone noticing.

export interface StatementCount {
  /** Statements executed, a batch counting each of its statements. */
  statements: number;
  /** The SQL of each executed statement, in order. Bound values are not kept. */
  sql: string[];
}

type Method = "run" | "all" | "first" | "raw";
const EXECUTE: ReadonlySet<string | symbol> = new Set<Method>(["run", "all", "first", "raw"]);

export function countingD1(real: D1Database): { d1: D1Database; count: StatementCount } {
  const count: StatementCount = { statements: 0, sql: [] };
  // A batch must receive the real statements, so keep the way back.
  const realOf = new WeakMap<object, D1PreparedStatement>();

  const wrap = (stmt: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") {
          return (...values: unknown[]) => wrap(target.bind(...values), sql);
        }
        const value = Reflect.get(target, prop);
        if (typeof value !== "function") return value;
        if (!EXECUTE.has(prop)) return value.bind(target);
        return (...args: unknown[]) => {
          count.statements += 1;
          count.sql.push(sql);
          return value.apply(target, args);
        };
      },
    });
    realOf.set(proxy, stmt);
    return proxy;
  };

  const d1 = new Proxy(real, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => wrap(target.prepare(sql), sql);
      if (prop === "batch") {
        return (stmts: D1PreparedStatement[]) => {
          count.statements += stmts.length;
          count.sql.push(`[batch of ${stmts.length}]`);
          return target.batch(stmts.map((s) => realOf.get(s) ?? s));
        };
      }
      if (prop === "exec") {
        return (query: string) => {
          const lines = query.split("\n").filter((l) => l.trim() !== "");
          count.statements += lines.length;
          count.sql.push(...lines);
          return target.exec(query);
        };
      }
      if (prop === "withSession" || prop === "dump") {
        throw new Error(`countingD1 does not count D1Database.${String(prop)}`);
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return { d1, count };
}
