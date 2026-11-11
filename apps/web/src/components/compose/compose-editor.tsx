import type { RefObject } from "react";
import { cn } from "@/lib/cn.ts";
import {
  FormatToolbar,
  type PendingCmd,
  RichEditor,
  type RichEditorHandle,
} from "../rich-editor.tsx";
import { Textarea } from "../ui/textarea.tsx";
import type { BodyFormat } from "./compose-utils.ts";

// The formatting toolbar and the body: the rich editor, the markdown preview,
// or the plain/markdown source. State and moves live in useComposeBody.
export function ComposeEditor({
  mode,
  text,
  onTextChange,
  html,
  onHtmlChange,
  preview,
  onTogglePreview,
  previewHtml,
  pendingCmd,
  editorRef,
  textareaRef,
  onFormat,
  onToggleMarkdown,
  onExitRich,
}: {
  mode: BodyFormat;
  text: string;
  onTextChange: (text: string) => void;
  html: string;
  onHtmlChange: (html: string) => void;
  preview: boolean;
  onTogglePreview: () => void;
  previewHtml: string;
  pendingCmd: PendingCmd | null;
  editorRef: RefObject<RichEditorHandle | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onFormat: (cmd: string, value?: string) => void;
  onToggleMarkdown: () => void;
  onExitRich: () => void;
}) {
  return (
    <>
      <FormatToolbar
        mode={mode}
        onExec={onFormat}
        onToggleMarkdown={onToggleMarkdown}
        preview={preview}
        onTogglePreview={onTogglePreview}
        onExitRich={onExitRich}
      />
      {mode === "html" ? (
        <RichEditor
          ref={editorRef}
          initialHtml={html}
          pendingCmd={pendingCmd}
          onChange={onHtmlChange}
          placeholder="Write your message…"
        />
      ) : mode === "markdown" && preview ? (
        <div
          // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized via DOMPurify
          dangerouslySetInnerHTML={{ __html: previewHtml }} // previewHtml is DOMPurify.sanitize() output
          className="prose prose-sm max-w-none flex-1 overflow-y-auto py-2 dark:prose-invert"
        />
      ) : (
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          className={cn(
            "min-h-40 flex-1 resize-none border-0 bg-transparent px-0 py-2 shadow-none focus-visible:ring-0",
            mode === "markdown" && "font-mono",
          )}
          placeholder={
            mode === "markdown" ? "Write your message in markdown…" : "Write your message…"
          }
        />
      )}
    </>
  );
}
