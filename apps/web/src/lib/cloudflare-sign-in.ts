// The sentence for a refused or broken Cloudflare sign-in, from the error code
// Better Auth puts on /login. "not_an_admin" is cfmail's own (auth.ts).
export function cloudflareSignInError(code: string | null): string | null {
  if (!code) return null;
  return code === "not_an_admin"
    ? "Cloudflare sign-in is only for this deployment's administrator. Sign in with your email and password instead."
    : "Signing in with Cloudflare did not finish. Try again.";
}
