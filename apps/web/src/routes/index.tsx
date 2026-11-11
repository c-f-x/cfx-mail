import { createFileRoute, redirect } from "@tanstack/react-router";
import { signedInUser } from "@/lib/current-user.ts";

export const Route = createFileRoute("/")({
  beforeLoad: async ({ context }) => {
    const user = await signedInUser(context.queryClient);
    throw redirect({ to: user ? "/app" : "/login" });
  },
});
