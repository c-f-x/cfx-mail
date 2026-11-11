import { describe, expect, it, vi } from "vitest";
import { ApiError } from "./api.ts";
import { createQueryClient, shouldRetry } from "./query-client.ts";

const unauthorized = () => new ApiError(401, { error: "unauthorized" }, "unauthorized");

describe("createQueryClient — a 401 means the session ended", () => {
  it("reports it when a query fails with 401", async () => {
    const onUnauthorized = vi.fn();
    const qc = createQueryClient(onUnauthorized);
    await qc
      .fetchQuery({
        queryKey: ["x"],
        queryFn: () => Promise.reject(unauthorized()),
        retry: false,
      })
      .catch(() => {});
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("reports it when a mutation fails with 401", async () => {
    const onUnauthorized = vi.fn();
    const qc = createQueryClient(onUnauthorized);
    await qc
      .getMutationCache()
      .build(qc, { mutationFn: () => Promise.reject(unauthorized()) })
      .execute(undefined)
      .catch(() => {});
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it("ignores other failures", async () => {
    const onUnauthorized = vi.fn();
    const qc = createQueryClient(onUnauthorized);
    const failures = [
      new ApiError(403, null, "forbidden"),
      new ApiError(500, null, "boom"),
      new Error("offline"),
    ];
    await Promise.all(
      failures.map((err, i) =>
        qc
          .fetchQuery({ queryKey: [i], queryFn: () => Promise.reject(err), retry: false })
          .catch(() => {}),
      ),
    );
    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

describe("shouldRetry", () => {
  it("retries transient failures up to three times", () => {
    expect(shouldRetry(0, new Error("offline"))).toBe(true);
    expect(shouldRetry(2, new ApiError(503, null, "down"))).toBe(true);
    expect(shouldRetry(3, new ApiError(503, null, "down"))).toBe(false);
  });

  it("does not retry an answer that will not change (4xx)", () => {
    for (const status of [400, 401, 403, 404]) {
      expect(shouldRetry(0, new ApiError(status, null, "no"))).toBe(false);
    }
  });
});
