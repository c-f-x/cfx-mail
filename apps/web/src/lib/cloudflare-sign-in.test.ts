import { describe, expect, it } from "vitest";
import { cloudflareSignInError } from "./cloudflare-sign-in.ts";

// Cloudflare sign-in sends the browser back to /login?error=<code> when cfmail
// refuses it. The code is the server's; the sentence is for the person.
describe("cloudflareSignInError", () => {
  it("explains that Cloudflare sign-in is only for the administrator", () => {
    expect(cloudflareSignInError("not_an_admin")).toBe(
      "Cloudflare sign-in is only for this deployment's administrator. Sign in with your email and password instead.",
    );
  });

  it("asks to try again for anything else that went wrong on the way", () => {
    expect(cloudflareSignInError("please_restart_the_process")).toBe(
      "Signing in with Cloudflare did not finish. Try again.",
    );
  });

  it("says nothing when there is no error", () => {
    expect(cloudflareSignInError(null)).toBeNull();
  });
});
