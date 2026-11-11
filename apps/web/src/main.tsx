import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouteError, RouteNotFound } from "./components/route-errors.tsx";
import { ConfirmProvider } from "./components/ui/confirm.tsx";
import { Toaster } from "./components/ui/toaster.tsx";
// Inter, self-hosted: the CSP allows fonts from this origin only.
import "@fontsource-variable/inter";
import "./styles/globals.css";
import { registerSW } from "./lib/pwa.ts";
import { createQueryClient } from "./lib/query-client.ts";
import { initTheme } from "./lib/theme.ts";
import { routeTree } from "./routeTree.gen.ts";

initTheme();
registerSW();

// A 401 from any call means the session ended. Same destination as the route
// guard and the stream probe (lib/sse.ts); not from /login itself, which would
// reload forever.
const queryClient = createQueryClient(() => {
  if (window.location.pathname !== "/login") window.location.assign("/login");
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  defaultErrorComponent: RouteError,
  defaultNotFoundComponent: RouteNotFound,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("no #root");

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <RouterProvider router={router} />
      </ConfirmProvider>
      <Toaster />
    </QueryClientProvider>
  </StrictMode>,
);
