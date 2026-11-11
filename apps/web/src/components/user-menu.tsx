import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Check,
  Keyboard,
  LogOut,
  Monitor,
  Moon,
  Settings,
  SlidersHorizontal,
  Sun,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";
import { accountOffers } from "@/lib/accounts.ts";
import { authClient } from "@/lib/auth-client.ts";
import { disablePush } from "@/lib/push.ts";
import { meQuery } from "@/lib/queries.ts";
import { signOutAndClear } from "@/lib/sign-out.ts";
import { useStreamStatus } from "@/lib/sse.ts";
import { type Theme, useTheme } from "@/lib/theme.ts";
import { setShortcutsHelpOpen } from "./shortcuts-dialog.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "./ui/avatar.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu.tsx";
import { Kbd } from "./ui/kbd.tsx";

const THEME_OPTIONS: { value: Theme; label: string; icon: typeof Monitor }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

/** The signed-in person (not an account): settings, theme, help, admin, sign out. */
export function UserMenu({ onNavigate }: { onNavigate?: () => void }) {
  const { data } = useQuery(meQuery);
  const user = data?.user;
  const nav = useNavigate();
  const qc = useQueryClient();
  const { theme, setTheme } = useTheme();
  const offers = accountOffers(user?.role);
  const initial = user?.name?.[0]?.toUpperCase() ?? user?.email?.[0]?.toUpperCase() ?? "?";

  function go(to: "/app/settings" | "/app/admin") {
    onNavigate?.();
    nav({ to });
  }

  async function signOut() {
    try {
      await signOutAndClear({
        disablePush,
        signOut: () => authClient.signOut(),
        clearCache: () => qc.clear(),
      });
    } catch {
      // The session may still be live; do not show the sign-in page as if it ended.
      toast.error("Couldn't sign out. Try again.");
      return;
    }
    nav({ to: "/login" });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-md px-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/45 data-popup-open:bg-sidebar-accent"
        aria-label="Your profile and settings"
      >
        <Avatar className="size-7 border bg-muted font-semibold text-[11px] text-muted-foreground">
          {user?.image && <AvatarImage src={user.image} alt="" />}
          <AvatarFallback>{initial}</AvatarFallback>
        </Avatar>
        <span className="truncate font-medium text-[13px]">{user?.name || user?.email}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="min-w-[15rem]">
        {user?.email && (
          <>
            <DropdownMenuLabel className="truncate normal-case">
              Signed in as {user.email}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={() => go("/app/settings")}>
          <Settings /> Settings
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setShortcutsHelpOpen(true)}>
          <Keyboard /> Keyboard shortcuts
          <Kbd className="ml-auto h-5 min-w-5 px-1 text-[10px]">?</Kbd>
        </DropdownMenuItem>
        {offers.admin && (
          <DropdownMenuItem onClick={() => go("/app/admin")}>
            <SlidersHorizontal /> Admin
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        {THEME_OPTIONS.map((opt) => (
          <DropdownMenuItem
            key={opt.value}
            closeOnClick={false}
            onClick={() => setTheme(opt.value)}
          >
            <opt.icon /> {opt.label}
            {theme === opt.value && <Check className="ml-auto !text-primary" />}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={signOut}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Shown only while the live-update stream is down; EventSource keeps retrying. */
export function StreamStatusIndicator() {
  const status = useStreamStatus();
  if (status === "connected") return null;
  return (
    <span
      title="Live updates disconnected — reconnecting…"
      className="grid size-8 shrink-0 place-items-center text-muted-foreground"
    >
      <WifiOff className="size-4 animate-pulse" aria-label="Reconnecting" />
    </span>
  );
}
