import type { ErrorComponentProps } from "@tanstack/react-router";
import { FileQuestion } from "lucide-react";
import { BackToInbox, EmptyState, LoadError } from "./ui.tsx";

// The router's fallback when a route's loader or component throws.
export function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <LoadError error={error} onRetry={reset} />
    </div>
  );
}

// The router's fallback for a URL that matches no route.
export function RouteNotFound() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState icon={FileQuestion} title="That page doesn't exist." action={<BackToInbox />} />
    </div>
  );
}
