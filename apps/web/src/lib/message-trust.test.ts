import { describe, expect, it } from "vitest";
import { authStatus, showSenderControlledBanners } from "./message-trust.ts";

const pass = { spf: "pass", dkim: "pass", dmarc: "pass" };
const forged = { spf: "fail", dkim: "fail", dmarc: "fail" };

describe("authStatus", () => {
  it("passes on aligned DMARC, or on SPF and DKIM together", () => {
    expect(authStatus(pass)).toBe("pass");
    expect(authStatus({ spf: "pass", dkim: "pass" })).toBe("pass");
  });

  it("fails on DMARC fail, or on SPF and DKIM both failing", () => {
    expect(authStatus(forged)).toBe("fail");
    expect(authStatus({ spf: "fail", dkim: "fail" })).toBe("fail");
  });

  it("is null without data and unverified when only part of the picture is known", () => {
    expect(authStatus(null)).toBeNull();
    expect(authStatus({})).toBeNull();
    expect(authStatus({ spf: "pass" })).toBe("unverified");
  });
});

describe("showSenderControlledBanners", () => {
  it("shows them for ordinary and authenticated mail", () => {
    expect(showSenderControlledBanners({ spamVerdict: null, spamAuth: null }, false)).toBe(true);
    expect(showSenderControlledBanners({ spamVerdict: "clean", spamAuth: pass }, false)).toBe(true);
  });

  it("hides them for a message flagged as spam", () => {
    expect(showSenderControlledBanners({ spamVerdict: "spam", spamAuth: pass }, false)).toBe(false);
  });

  it("hides them when the thread sits in Spam, whatever the verdict", () => {
    expect(showSenderControlledBanners({ spamVerdict: null, spamAuth: pass }, true)).toBe(false);
  });

  it("hides them when the sender failed authentication", () => {
    expect(showSenderControlledBanners({ spamVerdict: null, spamAuth: forged }, false)).toBe(false);
  });

  it("keeps them for a merely suspicious message that did not fail authentication", () => {
    expect(
      showSenderControlledBanners({ spamVerdict: "suspicious", spamAuth: { spf: "pass" } }, false),
    ).toBe(true);
  });
});
