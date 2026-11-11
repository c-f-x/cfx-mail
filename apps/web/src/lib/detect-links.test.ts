// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { detectLinks } from "./detect-links.ts";

const tracking = (input: Parameters<typeof detectLinks>[0]) => detectLinks(input).tracking;

describe("tracking carrier", () => {
  const text = "Ihre Sendung ist unterwegs.\nSendungsnummer: 00340434512327126914";

  it("attributes an ambiguous digit run to the sending carrier", () => {
    const [t] = tracking({ from: "paketankuendigung@dhl.de", subject: "Paket", text });
    expect(t?.carrier).toBe("DHL");
  });

  it("uses the only carrier the mail names", () => {
    const [t] = tracking({
      from: "shop@example.com",
      text: "Shipped via FedEx. Tracking number: 123456789012",
    });
    expect(t?.carrier).toBe("FedEx");
    const [d] = tracking({
      from: "shop@example.com",
      text: "Versand mit DHL. Sendungsnummer: 123456789012",
    });
    expect(d?.carrier).toBe("DHL");
  });

  it("recognises a DHL Paket 'Sendung verfolgen' link", () => {
    const [t] = tracking({
      html: '<p>Paket unterwegs</p><a href="https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=00340434512327126914">Sendung verfolgen</a>',
    });
    expect(t).toMatchObject({ carrier: "DHL", number: "00340434512327126914" });
  });
});

const magic = (anchorText: string, href: string) =>
  detectLinks({
    subject: "Your sign-in link",
    html: `<p>Hello</p><a href="${href}">${anchorText}</a>`,
  }).links;

describe("sign-in links", () => {
  it("never carries the sender's anchor text, only the link and its host", () => {
    const links = magic(
      "Sign in to your bank",
      "https://login.evil.example/magic/AbCdEfGhIjKlMnOpQrSt",
    );
    expect(links).toEqual([
      { url: "https://login.evil.example/magic/AbCdEfGhIjKlMnOpQrSt", host: "login.evil.example" },
    ]);
  });

  it("shows an internationalised look-alike host in its punycode form", () => {
    const [link] = magic("Sign in", "https://\u0430pple.example/magic/AbCdEfGhIjKlMnOpQrSt");
    expect(link?.host).toBe("xn--pple-43d.example");
  });

  it("still finds nothing for a non-https or unsubscribe link", () => {
    expect(magic("Sign in", "http://x.example/magic/AbCdEfGhIjKlMnOpQrSt")).toEqual([]);
    expect(
      magic("Unsubscribe", "https://x.example/unsubscribe?token=AbCdEfGhIjKlMnOpQrSt"),
    ).toEqual([]);
  });
});
