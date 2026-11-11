// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { metadataRefusedMessage, stripImageMetadata } from "./strip-image-metadata.ts";

// Photo metadata (GPS position, camera) must never leave the browser when the
// sender asked for it to be removed. When it cannot be removed, the image is
// refused rather than sent as it is.

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const bytesOf = async (f: File) => new Uint8Array(await f.arrayBuffer());
const contains = (hay: Uint8Array, needle: string) =>
  new TextDecoder("latin1").decode(hay).includes(needle);

// A JPEG with an Exif segment holding a fake GPS tag, then the image data.
function jpeg({ exif }: { exif: boolean }): number[] {
  const payload = [...ascii("Exif"), 0, 0, ...ascii("GPS-52.1N")];
  const app1 = exif ? [0xff, 0xe1, 0, payload.length + 2, ...payload] : [];
  return [0xff, 0xd8, ...app1, 0xff, 0xda, 0, 2, ...ascii("pixels"), 0xff, 0xd9];
}

function pngChunk(type: string, data: number[]): number[] {
  const len = data.length;
  // The CRC is not checked by the stripper, so any four bytes do.
  return [
    len >>> 24,
    (len >>> 16) & 255,
    (len >>> 8) & 255,
    len & 255,
    ...ascii(type),
    ...data,
    0,
    0,
    0,
    0,
  ];
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const IHDR = pngChunk(
  "IHDR",
  Array.from({ length: 13 }, () => 0),
);
const TEXT = pngChunk("tEXt", ascii("GPS\u000052.1N"));
const IDAT = pngChunk("IDAT", ascii("pixels"));
const IEND = pngChunk("IEND", []);

// A JPEG segment: marker, two length bytes (which count themselves), data.
const seg = (marker: number, data: number[]) => [
  0xff,
  marker,
  (data.length + 2) >>> 8,
  (data.length + 2) & 255,
  ...data,
];
const SOI = [0xff, 0xd8];
const JFIF = seg(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
const ICC = seg(0xe2, [...ascii("ICC_PROFILE"), 0, 1, 1, ...ascii("colours")]);
const DQT = seg(0xdb, [0, ...ascii("tables")]);
const SOF = seg(0xc2, ascii("frame"));
const DHT = seg(0xc4, ascii("huffman"));
// A scan: its header, then entropy-coded data. 0xff 0x00 is an escaped byte
// and 0xff 0xd0 a restart marker; both belong to the scan.
const scan = (label: string) => [
  ...seg(0xda, [1, 0, 0]),
  ...ascii(label),
  0xff,
  0x00,
  ...ascii("more"),
  0xff,
  0xd0,
  ...ascii("rest"),
];
const EOI = [0xff, 0xd9];
const CLEAN_JPEG = [
  ...SOI,
  ...JFIF,
  ...ICC,
  ...DQT,
  ...SOF,
  ...DHT,
  ...scan("one"),
  ...DHT,
  ...scan("two"),
  ...EOI,
];

function riffChunk(type: string, data: number[]): number[] {
  const n = data.length;
  return [
    ...ascii(type),
    n & 255,
    (n >>> 8) & 255,
    (n >>> 16) & 255,
    n >>> 24,
    ...data,
    ...(n % 2 ? [0] : []),
  ];
}
function webp(chunks: number[][]): number[] {
  const body = [...ascii("WEBP"), ...chunks.flat()];
  const n = body.length;
  return [...ascii("RIFF"), n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24, ...body];
}
// VP8X flags: 0x20 colour profile, 0x10 alpha, 0x08 Exif, 0x04 XMP, 0x02 animation.
const vp8x = (flags: number) => riffChunk("VP8X", [flags, 0, 0, 0, 9, 0, 0, 9, 0, 0]);
const VP8L = riffChunk("VP8L", ascii("pixels!"));

// GIF: header, a screen descriptor without a global colour table, then blocks.
const GIF_HEAD = [...ascii("GIF89a"), 1, 0, 1, 0, 0, 0, 0];
const subBlocks = (data: number[]) => [data.length, ...data, 0];
const LOOP = [0x21, 0xff, 11, ...ascii("NETSCAPE2.0"), ...subBlocks([1, 0, 0])];
const GRAPHIC = [0x21, 0xf9, 4, 0, 0, 0, 0, 0];
const IMAGE = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, ...subBlocks(ascii("lzw"))];
const TRAILER = [0x3b];

const file = (bytes: number[], type: string) =>
  new File([new Uint8Array(bytes)], "photo", { type });

describe("stripImageMetadata", () => {
  it("removes the Exif segment from a JPEG and keeps the image data", async () => {
    const result = await stripImageMetadata(file(jpeg({ exif: true }), "image/jpeg"));
    if (!result.ok) throw new Error(result.reason);
    const out = await bytesOf(result.file);
    expect(contains(out, "GPS")).toBe(false);
    expect(Array.from(out)).toEqual(jpeg({ exif: false }));
  });

  it("removes text chunks from a PNG and keeps the image chunks", async () => {
    const png = [...PNG_SIGNATURE, ...IHDR, ...TEXT, ...IDAT, ...IEND];
    const result = await stripImageMetadata(file(png, "image/png"));
    if (!result.ok) throw new Error(result.reason);
    expect(Array.from(await bytesOf(result.file))).toEqual([
      ...PNG_SIGNATURE,
      ...IHDR,
      ...IDAT,
      ...IEND,
    ]);
  });

  it("passes a clean image through unchanged", async () => {
    const png = file([...PNG_SIGNATURE, ...IHDR, ...IDAT, ...IEND], "image/png");
    expect(await stripImageMetadata(png)).toEqual({ ok: true, file: png });
  });

  it("refuses a JPEG it cannot read instead of sending it as it is", async () => {
    const broken = [...jpeg({ exif: true }).slice(0, 8), ...ascii("not a jpeg any more")];
    const result = await stripImageMetadata(file([0x00, ...broken], "image/jpeg"));
    expect(result.ok).toBe(false);
  });

  it("refuses a PNG whose chunks run past its end", async () => {
    // A metadata chunk that claims more bytes than the file holds hides what
    // follows it, so the file cannot be shown to be clean.
    const lying = pngChunk("tEXt", ascii("GPS\u000052.1N"));
    lying[3] = 200;
    const png = [...PNG_SIGNATURE, ...IHDR, ...lying, ...IDAT, ...IEND];
    expect((await stripImageMetadata(file(png, "image/png"))).ok).toBe(false);
  });

  it("tells the sender which image was not attached, why, and how to send it anyway", () => {
    expect(metadataRefusedMessage("IMG_0042.jpg")).toBe(
      "IMG_0042.jpg was not attached: its photo details, such as where it was taken, could not be removed. Untick “Remove image metadata” to send it as it is.",
    );
  });

  describe("JPEG", () => {
    const strip = async (bytes: number[]) => {
      const result = await stripImageMetadata(file(bytes, "image/jpeg"));
      if (!result.ok) throw new Error(result.reason);
      return Array.from(await bytesOf(result.file));
    };

    it("keeps everything needed to draw the image, across several scans", async () => {
      expect(await strip(CLEAN_JPEG)).toEqual(CLEAN_JPEG);
    });

    it("removes an XMP block, which can hold the position too", async () => {
      const xmp = seg(0xe1, [
        ...ascii("http://ns.adobe.com/xap/1.0/"),
        0,
        ...ascii("<exif:GPSLatitude>52,1N</exif:GPSLatitude>"),
      ]);
      expect(await strip([...SOI, ...JFIF, ...xmp, ...CLEAN_JPEG.slice(2 + JFIF.length)])).toEqual(
        CLEAN_JPEG,
      );
    });

    it("removes IPTC, comments and other application blocks", async () => {
      const iptc = seg(0xed, [...ascii("Photoshop 3.0"), 0, ...ascii("City: Oslo")]);
      const comment = seg(0xfe, ascii("taken at home"));
      const maker = seg(0xeb, ascii("GPS-52.1N"));
      const out = await strip([...SOI, ...iptc, ...comment, ...maker, ...CLEAN_JPEG.slice(2)]);
      expect(out).toEqual(CLEAN_JPEG);
    });

    it("removes the extra images a phone appends after the main one", async () => {
      // Multi-picture files index their extra images in an APP2 "MPF" block
      // and append them after the end marker, each with its own Exif.
      const mpf = seg(0xe2, [...ascii("MPF"), 0, ...ascii("index")]);
      const extra = [...SOI, ...seg(0xe1, [...ascii("Exif"), 0, 0, ...ascii("GPS-52.1N")]), ...EOI];
      const out = await strip([...SOI, ...mpf, ...CLEAN_JPEG.slice(2), ...extra]);
      expect(out).toEqual(CLEAN_JPEG);
      expect(contains(new Uint8Array(out), "GPS")).toBe(false);
    });

    it("refuses a JPEG whose image data never ends", async () => {
      expect((await stripImageMetadata(file(CLEAN_JPEG.slice(0, -2), "image/jpeg"))).ok).toBe(
        false,
      );
    });

    it("refuses a segment that claims more bytes than the file holds", async () => {
      const lying = seg(0xe1, ascii("Exif"));
      lying[3] = 200;
      expect((await stripImageMetadata(file([...SOI, ...lying, ...EOI], "image/jpeg"))).ok).toBe(
        false,
      );
    });
  });

  describe("WebP", () => {
    it("removes the Exif and XMP chunks and their flags", async () => {
      const exif = riffChunk("EXIF", ascii("GPS-52.1N"));
      const xmp = riffChunk("XMP ", ascii("<exif:GPSLatitude>52,1N"));
      const result = await stripImageMetadata(
        file(webp([vp8x(0x10 | 0x08 | 0x04), VP8L, exif, xmp]), "image/webp"),
      );
      if (!result.ok) throw new Error(result.reason);
      expect(Array.from(await bytesOf(result.file))).toEqual(webp([vp8x(0x10), VP8L]));
    });

    it("passes a WebP without metadata through unchanged", async () => {
      const clean = file(webp([VP8L]), "image/webp");
      expect(await stripImageMetadata(clean)).toEqual({ ok: true, file: clean });
    });

    it("refuses a chunk that runs past the end of the file", async () => {
      const lying = riffChunk("EXIF", ascii("GPS"));
      lying[4] = 200;
      const bytes = webp([VP8L, lying]);
      expect((await stripImageMetadata(file(bytes, "image/webp"))).ok).toBe(false);
    });

    it("refuses a file that claims to be a WebP but is not one", async () => {
      expect((await stripImageMetadata(file(ascii("RIFFxxxxWAVE"), "image/webp"))).ok).toBe(false);
    });
  });

  describe("GIF", () => {
    it("removes comments and XMP and keeps the animation loop and the frames", async () => {
      const comment = [0x21, 0xfe, ...subBlocks(ascii("GPS-52.1N"))];
      const xmp = [0x21, 0xff, 11, ...ascii("XMP DataXMP"), ...subBlocks(ascii("<GPS>"))];
      const result = await stripImageMetadata(
        file(
          [...GIF_HEAD, ...LOOP, ...comment, ...xmp, ...GRAPHIC, ...IMAGE, ...TRAILER],
          "image/gif",
        ),
      );
      if (!result.ok) throw new Error(result.reason);
      expect(Array.from(await bytesOf(result.file))).toEqual([
        ...GIF_HEAD,
        ...LOOP,
        ...GRAPHIC,
        ...IMAGE,
        ...TRAILER,
      ]);
    });

    it("refuses a GIF that ends before its trailer", async () => {
      const bytes = [...GIF_HEAD, ...GRAPHIC, ...IMAGE];
      expect((await stripImageMetadata(file(bytes, "image/gif"))).ok).toBe(false);
    });
  });

  it.each(["image/heic", "image/heif", "image/avif", "image/tiff"])(
    "refuses %s, whose details cannot be removed in the browser",
    async (type) => {
      expect((await stripImageMetadata(file(ascii("ftypheic GPS-52.1N"), type))).ok).toBe(false);
    },
  );

  it("refuses a file that claims to be a PNG but is not one", async () => {
    const result = await stripImageMetadata(file(ascii("GPS 52.1N, not an image"), "image/png"));
    expect(result.ok).toBe(false);
  });
});
