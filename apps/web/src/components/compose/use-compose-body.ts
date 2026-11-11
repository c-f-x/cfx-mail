import { useRef, useState } from "react";
import { htmlToText, type PendingCmd, type RichEditorHandle, textToHtml } from "../rich-editor.tsx";
import { type BodyFormat, resolveInlineImages } from "./compose-utils.ts";
import { loadMarkdownLibs, useMarkdownLibs } from "./markdown-libs.ts";

// The message body and its editor: plain text, markdown (with preview) or rich
// HTML, and the moves between them.
export function useComposeBody(initial: { format: BodyFormat; text: string; html: string }) {
  const [mode, setMode] = useState<BodyFormat>(initial.format);
  // `text` holds the plain/markdown source; `html` holds the rich-mode body.
  const [text, setText] = useState(initial.text);
  const [html, setHtml] = useState(initial.html);
  const [preview, setPreview] = useState(false);
  const editorRef = useRef<RichEditorHandle>(null);
  const bodyTextareaRef = useRef<HTMLTextAreaElement>(null);
  // A format command queued while still in plain text — applied once the editor
  // mounts after promotion to HTML.
  const pendingCmdRef = useRef<PendingCmd | null>(null);

  const mdLibs = useMarkdownLibs();
  const previewHtml = (() => {
    if (mode !== "markdown" || !text.trim() || !mdLibs) return "";
    const rendered = mdLibs.marked.parse(text, { async: false }) as string;
    return mdLibs.DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } });
  })();

  // The body as plain text, whatever the editor.
  const composedText = mode === "html" ? htmlToText(html) : text;

  // Resolve the editor state into the wire body: plain text → text only;
  // markdown → text source + rendered html; rich → sanitized html plus a derived
  // text alternative for non-HTML clients. Shared by immediate + scheduled send.
  const buildBody = async (): Promise<{
    text: string | undefined;
    html: string | undefined;
  }> => {
    if (mode === "html") {
      const { html: resolved } = resolveInlineImages(html);
      if (!resolved.trim()) return { html: undefined, text: undefined };
      const { DOMPurify } = await loadMarkdownLibs();
      const htmlBody = DOMPurify.sanitize(resolved, { USE_PROFILES: { html: true } });
      return { html: htmlBody, text: htmlToText(html) || undefined };
    }
    if (mode === "markdown") {
      if (!text.trim()) return { text, html: undefined };
      const { marked, DOMPurify } = await loadMarkdownLibs();
      const rendered = marked.parse(text, { async: false }) as string;
      return { text, html: DOMPurify.sanitize(rendered, { USE_PROFILES: { html: true } }) };
    }
    return { text, html: undefined };
  };

  // Inline images land in the HTML body, promoting a plain-text draft to rich
  // when needed.
  function embedInlineHtml(imgHtml: string) {
    if (mode === "html") {
      editorRef.current?.insertHtml(imgHtml);
    } else {
      setHtml(`${textToHtml(text)}${imgHtml}`);
      pendingCmdRef.current = null;
      setMode("html");
    }
  }

  // A formatting tool was used. In HTML mode run it directly; otherwise promote
  // the plain-text body to HTML and queue the command for the mounting editor.
  function runFormat(cmd: string, value?: string) {
    if (mode === "html") {
      editorRef.current?.exec(cmd, value);
      return;
    }
    setHtml(textToHtml(text));
    pendingCmdRef.current = { cmd, value };
    setMode("html");
  }

  // Drop rich formatting back to a plain-text body.
  function exitRich() {
    setText(htmlToText(html));
    pendingCmdRef.current = null;
    setMode("text");
  }

  function toggleMarkdown() {
    if (mode === "markdown") {
      setPreview(false);
      setMode("text");
      return;
    }
    if (mode === "html") setText(htmlToText(html));
    pendingCmdRef.current = null;
    setMode("markdown");
  }

  // Insert plain text at the caret: as HTML in the rich editor, spliced into
  // the source otherwise, with the caret placed after it.
  function insertAtCaret(inserted: string) {
    if (mode === "html") {
      editorRef.current?.insertHtml(textToHtml(inserted));
      return;
    }
    const ta = bodyTextareaRef.current;
    const start = ta?.selectionStart ?? text.length;
    const end = ta?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + inserted + text.slice(end));
    requestAnimationFrame(() => {
      const caret = start + inserted.length;
      ta?.focus();
      ta?.setSelectionRange(caret, caret);
    });
  }

  // Where focus goes when leaving the Subject field with Tab.
  const focusTarget = () => (mode === "html" ? editorRef.current : bodyTextareaRef.current);

  return {
    mode,
    text,
    setText,
    html,
    setHtml,
    preview,
    setPreview,
    previewHtml,
    composedText,
    editorRef,
    bodyTextareaRef,
    pendingCmdRef,
    buildBody,
    embedInlineHtml,
    runFormat,
    exitRich,
    toggleMarkdown,
    insertAtCaret,
    focusTarget,
  };
}

export type ComposeBody = ReturnType<typeof useComposeBody>;
