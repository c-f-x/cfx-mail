import { describe, expect, it } from "vitest";
import { unsubscribeConfirm } from "./unsubscribe.ts";

describe("unsubscribeConfirm", () => {
  it("names the address of a mailto request", () => {
    expect(unsubscribeConfirm({ method: "email", address: "unsub@news.example" }).title).toBe(
      "Send an unsubscribe email to unsub@news.example?",
    );
  });

  it("names the host of a one-click request", () => {
    expect(unsubscribeConfirm({ method: "one-click", host: "news.example" }).title).toBe(
      "Send an unsubscribe request to news.example?",
    );
  });

  it("names the host of a page that will be opened", () => {
    expect(unsubscribeConfirm({ method: "link", host: "news.example" }).title).toBe(
      "Open the unsubscribe page at news.example?",
    );
  });
});
