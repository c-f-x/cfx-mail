// A response body as text, whatever its content type. Calling .text() on an
// image or PDF response makes workerd print a warning, and test output stays
// clean only if the bytes are decoded explicitly.
export async function bodyText(res: Response): Promise<string> {
  return new TextDecoder().decode(await res.arrayBuffer());
}
