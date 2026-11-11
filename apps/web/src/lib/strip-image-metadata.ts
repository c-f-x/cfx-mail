// Lossless removal of privacy-sensitive image metadata (Exif, XMP, IPTC,
// comments) before an image leaves the browser. "Lossless" = the pixel data is
// never re-encoded; we only drop metadata segments, chunks and blocks, so
// quality and size are preserved. JPEG, PNG, WebP and GIF are rewritten.
//
// It fails closed: a file that cannot be read cannot be shown to be clean, so
// it is refused instead of sent as it is. Other formats (HEIC, AVIF, TIFF) keep
// their details in structures a browser cannot rewrite safely, so they are
// refused too.

export type StripResult = { ok: true; file: File } | { ok: false; reason: string };

/** What the sender is told when an image is refused. */
export function metadataRefusedMessage(fileName: string): string {
  return `${fileName} was not attached: its photo details, such as where it was taken, could not be removed. Untick “Remove image metadata” to send it as it is.`;
}

export async function stripImageMetadata(file: File): Promise<StripResult> {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const parts =
      file.type === "image/jpeg"
        ? stripJpeg(buf)
        : file.type === "image/png"
          ? stripPng(buf)
          : file.type === "image/webp"
            ? stripWebp(buf)
            : file.type === "image/gif"
              ? stripGif(buf)
              : ({ ok: false, reason: `no way to remove details from ${file.type}` } as const);
    if (!parts.ok) return parts;
    if (parts.unchanged) return { ok: true, file };
    return {
      ok: true,
      file: new File(parts.bytes as BlobPart[], file.name, { type: file.type }),
    };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

type Parts = { ok: true; unchanged: boolean; bytes: Uint8Array[] } | { ok: false; reason: string };
const refuse = (reason: string): Parts => ({ ok: false, reason });
const ascii = (buf: Uint8Array, from: number, length: number) =>
  String.fromCharCode(...buf.subarray(from, from + length));

// JPEG: walk the segments and keep only what decoding and colour need: the
// JFIF header, an ICC colour profile, the Adobe colour-transform block, and
// every non-application segment (tables, frame, scans). Exif and XMP (APP1),
// IPTC (APP13), multi-picture indexes (APP2 "MPF"), other application blocks
// and comments go. So does anything after the end marker, where phones append
// further images that carry their own Exif.
function stripJpeg(buf: Uint8Array): Parts {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return refuse("not a JPEG");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Uint8Array[] = [buf.subarray(0, 2)];
  let offset = 2;
  let changed = false;
  for (;;) {
    if (offset + 2 > buf.length) return refuse("the JPEG ends before its end marker");
    if (buf[offset] !== 0xff) return refuse("unexpected bytes between JPEG segments");
    const marker = buf[offset + 1]!;
    if (marker === 0xff) {
      offset++; // fill byte
      continue;
    }
    if (marker === 0xd9) {
      out.push(buf.subarray(offset, offset + 2));
      if (offset + 2 < buf.length) changed = true;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(buf.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (offset + 4 > buf.length) return refuse("a JPEG segment runs past the end");
    const length = view.getUint16(offset + 2);
    const end = offset + 2 + length;
    // A segment that runs past the end hides whatever follows it.
    if (length < 2 || end > buf.length) return refuse("a JPEG segment runs past the end");
    if (keepJpegSegment(marker, buf, offset + 4, end)) out.push(buf.subarray(offset, end));
    else changed = true;
    offset = end;
    if (marker === 0xda) {
      // Entropy-coded data runs to the next marker. Escaped bytes (0xff 0x00),
      // restart markers and fill bytes belong to it.
      const start = offset;
      while (offset + 1 < buf.length) {
        const next = buf[offset + 1]!;
        if (buf[offset] === 0xff && next !== 0 && next !== 0xff && (next < 0xd0 || next > 0xd7)) {
          break;
        }
        offset++;
      }
      if (offset + 1 >= buf.length) return refuse("the JPEG image data never ends");
      out.push(buf.subarray(start, offset));
    }
  }
  return { ok: true, unchanged: !changed, bytes: out };
}

function keepJpegSegment(marker: number, buf: Uint8Array, from: number, end: number): boolean {
  const startsWith = (id: string) => end - from >= id.length && ascii(buf, from, id.length) === id;
  if (marker === 0xe0) return startsWith("JFIF\0");
  if (marker === 0xe2) return startsWith("ICC_PROFILE\0");
  if (marker === 0xee) return startsWith("Adobe");
  return !(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe;
}

// PNG: walk the chunk stream and drop ancillary metadata chunks. Critical
// chunks (IHDR/PLTE/IDAT/IEND) and render-affecting ancillary chunks are kept,
// so the image renders identically. CRCs of kept chunks are untouched.
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const PNG_DROP = new Set(["tEXt", "zTXt", "iTXt", "eXIf", "tIME", "dSIG"]);

function stripPng(buf: Uint8Array): Parts {
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) return refuse("not a PNG");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Uint8Array[] = [buf.subarray(0, 8)];
  let offset = 8;
  let changed = false;
  while (offset + 8 <= buf.length) {
    const length = view.getUint32(offset);
    const type = ascii(buf, offset + 4, 4);
    const end = offset + 12 + length; // length + 4 type + 4 crc
    // A chunk that runs past the end hides whatever follows it.
    if (end > buf.length) return refuse("a PNG chunk runs past the end");
    if (PNG_DROP.has(type)) {
      changed = true;
    } else {
      out.push(buf.subarray(offset, end));
    }
    if (type === "IEND") break;
    offset = end;
  }
  return { ok: true, unchanged: !changed, bytes: out };
}

// WebP: a RIFF file of chunks. Drop the EXIF and XMP chunks, clear their flags
// in the VP8X header, and write the new RIFF size. Every chunk is padded to an
// even length.
const WEBP_DROP = new Set(["EXIF", "XMP "]);
const VP8X_EXIF_XMP = 0x08 | 0x04;

function stripWebp(buf: Uint8Array): Parts {
  if (buf.length < 12 || ascii(buf, 0, 4) !== "RIFF" || ascii(buf, 8, 4) !== "WEBP") {
    return refuse("not a WebP");
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const riffEnd = 8 + view.getUint32(4, true);
  if (riffEnd > buf.length) return refuse("the WebP is shorter than it says");
  const chunks: Uint8Array[] = [];
  let changed = riffEnd < buf.length;
  let offset = 12;
  while (offset < riffEnd) {
    if (offset + 8 > riffEnd) return refuse("a WebP chunk runs past the end");
    const type = ascii(buf, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const end = Math.min(offset + 8 + size + (size % 2), riffEnd);
    if (offset + 8 + size > riffEnd) return refuse("a WebP chunk runs past the end");
    if (WEBP_DROP.has(type)) {
      changed = true;
    } else if (type === "VP8X" && size > 0 && (buf[offset + 8]! & VP8X_EXIF_XMP) !== 0) {
      const header = buf.slice(offset, end);
      header[8] = header[8]! & ~VP8X_EXIF_XMP;
      chunks.push(header);
      changed = true;
    } else {
      chunks.push(buf.subarray(offset, end));
    }
    offset = end;
  }
  if (!changed) return { ok: true, unchanged: true, bytes: [] };
  const riff = new Uint8Array(12);
  riff.set(buf.subarray(0, 12));
  const size = 4 + chunks.reduce((n, c) => n + c.length, 0);
  new DataView(riff.buffer).setUint32(4, size, true);
  return { ok: true, unchanged: false, bytes: [riff, ...chunks] };
}

// GIF: a header, a screen descriptor with an optional colour table, then
// blocks until the trailer. Keep the frames, their timing (graphic control),
// plain-text frames, and the application blocks that loop animations or carry
// a colour profile. Comments, XMP and other application blocks go.
const GIF_KEEP_APPS = new Set(["NETSCAPE2.0", "ANIMEXTS1.0", "ICCRGBG1012"]);
// The byte length of the colour table a GIF descriptor's flags announce.
const colourTable = (flags: number) => (flags & 0x80 ? 3 * 2 ** ((flags & 7) + 1) : 0);

function stripGif(buf: Uint8Array): Parts {
  const head = ascii(buf, 0, 6);
  if (head !== "GIF87a" && head !== "GIF89a") return refuse("not a GIF");
  // Data sub-blocks: a length byte, that many bytes, until a zero length.
  const skipSubBlocks = (from: number): number | null => {
    let at = from;
    for (;;) {
      if (at >= buf.length) return null;
      const n = buf[at]!;
      at += 1 + n;
      if (n === 0) return at;
    }
  };
  let offset = 13 + colourTable(buf[10] ?? 0);
  const out: Uint8Array[] = [buf.subarray(0, offset)];
  let changed = false;
  for (;;) {
    if (offset >= buf.length) return refuse("the GIF ends before its trailer");
    const block = buf[offset]!;
    if (block === 0x3b) {
      out.push(buf.subarray(offset, offset + 1));
      if (offset + 1 < buf.length) changed = true;
      break;
    }
    let end: number | null;
    let keep = true;
    if (block === 0x21) {
      const label = buf[offset + 1];
      end = skipSubBlocks(offset + 2);
      if (label === 0xfe) keep = false;
      else if (label === 0xff)
        keep = buf[offset + 2] === 11 && GIF_KEEP_APPS.has(ascii(buf, offset + 3, 11));
      else keep = label === 0xf9 || label === 0x01;
    } else if (block === 0x2c) {
      // Descriptor (10 bytes), local colour table, LZW code size, data.
      end = skipSubBlocks(offset + 10 + colourTable(buf[offset + 9] ?? 0) + 1);
    } else {
      return refuse("unexpected bytes in the GIF");
    }
    if (end === null || end > buf.length) return refuse("a GIF block runs past the end");
    if (keep) out.push(buf.subarray(offset, end));
    else changed = true;
    offset = end;
  }
  return { ok: true, unchanged: !changed, bytes: out };
}
