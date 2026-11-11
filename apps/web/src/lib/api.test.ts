import { describe, expect, it } from "vitest";
import { ApiError, unwrap } from "./api.ts";

// `unwrap` takes what the typed client returns: a promise of a Response.
const answer = (status: number, body: unknown, contentType = "application/json") =>
  Promise.resolve(
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": contentType },
    }),
  ) as unknown as Parameters<typeof unwrap>[0];

async function failure(promise: Parameters<typeof unwrap>[0]): Promise<ApiError> {
  const error = await unwrap(promise).then(
    () => null,
    (err: unknown) => err,
  );
  if (!(error instanceof ApiError)) throw new Error("expected an ApiError");
  return error;
}

describe("unwrap", () => {
  it("returns the JSON body of a success", async () => {
    expect(await unwrap(answer(200, { ok: true }))).toEqual({ ok: true });
  });

  it("turns a bare server code into a plain sentence, and keeps the code in the payload", async () => {
    const error = await failure(answer(500, { error: "internal_error" }));
    expect(error.message).toBe("The server didn't respond. Try again in a moment.");
    expect(error.status).toBe(500);
    expect(error.payload).toEqual({ error: "internal_error" });
  });

  it.each([
    [403, "forbidden", "You don't have access to this."],
    [404, "not found", "This doesn't exist any more."],
    [429, "rate limit exceeded", "Too many requests. Wait a minute and try again."],
    [401, "unauthenticated", "Something went wrong. Try again."],
  ])("maps %i %j", async (status, code, sentence) => {
    expect((await failure(answer(status, { error: code }))).message).toBe(sentence);
  });

  it("passes a sentence from the server through unchanged", async () => {
    const error = await failure(answer(409, { error: "Delete this domain's mailboxes first." }));
    expect(error.message).toBe("Delete this domain's mailboxes first.");
  });

  it("shows the sentence a failed validation answers with", async () => {
    // api/validate.ts answers every failed validation with { error: "<sentence>" }.
    const error = await failure(
      answer(400, { error: "Invalid input: expected string, received undefined." }),
    );
    expect(error.message).toBe("Invalid input: expected string, received undefined.");
    expect(error.status).toBe(400);
  });

  it("never shows a body that is not our JSON error, such as an HTML error page", async () => {
    const html = await failure(answer(502, "<html><body>Bad Gateway</body></html>", "text/html"));
    expect(html.message).toBe("The server didn't respond. Try again in a moment.");
    const text = await failure(answer(404, "404 Not Found", "text/plain"));
    expect(text.message).toBe("This doesn't exist any more.");
    const notASentence = await failure(answer(400, { error: { code: "invalid" } }));
    expect(notASentence.message).toBe("Something went wrong. Try again.");
  });

  it("reports a request that got no response as one, without the browser's wording", async () => {
    const error = await failure(
      Promise.reject(new TypeError("Failed to fetch")) as Parameters<typeof unwrap>[0],
    );
    expect(error.message).toBe("The server didn't respond. Try again in a moment.");
    expect(error.status).toBe(0);
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  it("lets other rejections through as they are", async () => {
    const aborted = new DOMException("aborted", "AbortError");
    await expect(unwrap(Promise.reject(aborted) as Parameters<typeof unwrap>[0])).rejects.toBe(
      aborted,
    );
  });
});
