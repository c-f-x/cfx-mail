// The host a link really goes to, for showing next to buttons the sender's text
// built. `URL` reports internationalised names in punycode ("xn--…"), which is
// what exposes a look-alike. Null when the string is not an absolute URL.
export function urlHost(url: string): string | null {
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}
