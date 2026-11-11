import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { messageBodyQuery } from "@/lib/queries.ts";
import { EmailFrame } from "../email-frame.tsx";
import { Button } from "../ui/button.tsx";
import type { QuoteRef } from "./compose-init.ts";

// The quoted original under a reply or forward, folded away until asked for.
// The server re-quotes from the raw `.eml` at send time (mail/quote.ts); this
// only shows what is being included.
export function QuotedMessage({ quote, snippet }: { quote: QuoteRef; snippet: string }) {
  const [showQuote, setShowQuote] = useState(false);
  const { data: origBodyData } = useQuery(messageBodyQuery(quote.messageId));
  // sanitize-email pulls in DOMPurify; loaded on demand (only a reply/forward
  // has a quoted body to sanitize) so it stays out of the first-paint chunk.
  const [quotedHtml, setQuotedHtml] = useState<string | null>(null);
  useEffect(() => {
    const raw = origBodyData?.html;
    if (!raw) {
      // quoted body is sanitized via a dynamic DOMPurify import; can't derive during render
      setQuotedHtml(null);
      return;
    }
    let cancelled = false;
    void import("@/lib/sanitize-email.ts").then(({ sanitizeEmailHtml }) => {
      if (!cancelled) setQuotedHtml(sanitizeEmailHtml(raw));
    });
    return () => {
      cancelled = true;
    };
  }, [origBodyData?.html]);

  return (
    <div className="mt-2 border-t pt-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setShowQuote((v) => !v)}
        className="h-6 px-1.5 text-[11px]"
      >
        {showQuote ? "Hide" : "Show"} quoted message
      </Button>
      <p className="mt-0.5 px-1.5 text-[11px] text-muted-foreground/70">
        The original message is included below your {quote.kind === "forward" ? "forward" : "reply"}
        .
      </p>
      {showQuote && (
        <div className="mt-2 max-h-64 overflow-y-auto rounded-md border bg-muted/30">
          {quotedHtml ? (
            // Same sandboxed isolation as the message view — the quoted
            // body is untrusted mail too.
            <EmailFrame html={quotedHtml} />
          ) : (
            <pre className="whitespace-pre-wrap px-3 py-2 font-sans text-[12px] text-muted-foreground">
              {origBodyData?.text ?? snippet}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
