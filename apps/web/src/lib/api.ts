import type { AppType } from "@cfx-mail/worker/api";
import type { ClientResponse } from "hono/client";
import { hc } from "hono/client";
import type { ResponseFormat } from "hono/types";
import type { SuccessStatusCode } from "hono/utils/http-status";
import { NO_RESPONSE, plainErrorMessage } from "./error-message.ts";

// `status` is NO_RESPONSE when the request got no answer. `message` is already
// fit to show a person; what the server sent stays in `payload`.
export class ApiError extends Error {
  constructor(
    public status: number,
    public payload: unknown,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

// What the API said went wrong: the `error` (or `message`) of its JSON body.
// Any other body, such as a proxy's HTML error page, is not ours to show.
function serverMessage(payload: unknown): string | null {
  if (payload && typeof payload === "object") {
    const obj = payload as Record<string, unknown>;
    const msg = obj.error ?? obj.message;
    if (typeof msg === "string") return msg;
  }
  return null;
}

// Typed RPC client over the worker's composed Hono app (`AppType` is imported
// type-only — no worker code ships to the browser). Every request path and
// response body is checked against the actual route definitions at compile time.
const client = hc<AppType>("/", {
  fetch: (input: RequestInfo | URL, init?: RequestInit) =>
    fetch(input, { credentials: "include", ...init }),
});

export const rpc = client.api;

// The JSON body of the success arm(s) of a route's response union. Error arms
// (4xx/5xx `{ error }` bodies) surface as a thrown ApiError instead, and
// contentless responses (204) yield undefined.
type OkBody<R> =
  R extends ClientResponse<infer D, infer S, infer F>
    ? S extends SuccessStatusCode
      ? F extends "json"
        ? D
        : undefined
      : never
    : never;

// Await an RPC call, keeping the old `api()` error contract: non-2xx throws an
// ApiError carrying status + parsed payload; 204 resolves to undefined. The
// error's message is a plain sentence (see plainErrorMessage), so callers can
// show it as it is.
export async function unwrap<R extends ClientResponse<unknown, number, ResponseFormat>>(
  promise: Promise<R>,
): Promise<OkBody<R>> {
  const res = await promise.catch((cause: unknown) => {
    // `fetch` rejects with a TypeError when no response arrived. Its message is
    // the browser's own ("Failed to fetch", "Load failed").
    if (cause instanceof TypeError)
      throw new ApiError(NO_RESPONSE, null, plainErrorMessage(NO_RESPONSE), { cause });
    throw cause;
  });
  if (!res.ok) {
    // Read the body once, then try to parse it — reading twice throws
    // "body stream already read".
    const raw = await res.text();
    let payload: unknown = raw;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      // not JSON — keep the raw text
    }
    throw new ApiError(res.status, payload, plainErrorMessage(res.status, serverMessage(payload)));
  }
  if (res.status === 204) return undefined as OkBody<R>;
  return (await res.json()) as OkBody<R>;
}
