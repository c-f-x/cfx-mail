import { describe, expect, it } from "vitest";
import { loadView } from "./load-state.ts";

const base = { count: 0, loading: false, error: false, fetching: false };

describe("loadView", () => {
  it("shows the list whenever there are rows, even if a refresh failed", () => {
    expect(loadView({ ...base, count: 3 })).toBe("content");
    expect(loadView({ ...base, count: 3, error: true })).toBe("content");
    expect(loadView({ ...base, count: 3, loading: true })).toBe("content");
  });

  it("shows loading until the first answer", () => {
    expect(loadView({ ...base, loading: true, fetching: true })).toBe("loading");
  });

  it("shows empty only for a successful, empty answer", () => {
    expect(loadView(base)).toBe("empty");
  });

  it("shows an error, not empty, when the load failed", () => {
    expect(loadView({ ...base, error: true })).toBe("error");
  });

  it("shows loading again while a failed load is retried", () => {
    expect(loadView({ ...base, error: true, fetching: true })).toBe("loading");
  });
});
