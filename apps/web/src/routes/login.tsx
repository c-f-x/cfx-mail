import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Cloud, KeyRound } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { CardShell, Field, PrimaryButton } from "@/components/auth-card.tsx";
import { Button } from "@/components/ui/button.tsx";
import { rpc, unwrap } from "@/lib/api.ts";
import { authClient } from "@/lib/auth-client.ts";
import { cloudflareSignInError } from "@/lib/cloudflare-sign-in.ts";
import { bootstrapQuery } from "@/lib/queries.ts";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const { data: bootstrap, isLoading } = useQuery(bootstrapQuery);
  if (isLoading) {
    return <CardShell title="Loading…" />;
  }
  if (bootstrap?.needsBootstrap) {
    if (bootstrap.cloudflareSignIn) return <CloudflareSetup />;
    return bootstrap.setupLocked ? <SetupLocked /> : <BootstrapForm />;
  }
  return <SignInForm cloudflare={Boolean(bootstrap?.cloudflareSignIn)} />;
}

// Admins sign in with their Cloudflare account. Cloudflare sends the browser
// back to /app, or to /login with an error code when cfmail refuses.
function CloudflareButton({ label, disabled }: { label: string; disabled?: boolean }) {
  const [busy, setBusy] = useState(false);
  async function start() {
    setBusy(true);
    const res = await authClient.signIn.social({
      provider: "cloudflare",
      callbackURL: "/app",
      errorCallbackURL: "/login",
    });
    // On success the browser is already on its way to Cloudflare.
    if (res.error) {
      toast.error(cloudflareSignInError(res.error.code ?? "failed"));
      setBusy(false);
    }
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="lg"
      disabled={disabled || busy}
      onClick={start}
      className="mt-1 w-full"
    >
      <Cloud className="size-4" />
      {label}
    </Button>
  );
}

// A new deployment with Cloudflare sign-in: whoever runs it signs in with
// their Cloudflare account and becomes its administrator.
function CloudflareSetup() {
  return (
    <CardShell title="Set up this deployment">
      <p className="mb-4 text-sm text-muted-foreground">
        Sign in with the Cloudflare account that runs this deployment. You become its administrator,
        and invite or create everyone else from the dashboard.
      </p>
      <CloudflareButton label="Set up with Cloudflare" />
    </CardShell>
  );
}

// The Worker has no SETUP_TOKEN secret, so the server refuses every attempt to
// create the administrator. Say so instead of showing a form that cannot work.
function SetupLocked() {
  return (
    <CardShell title="Setup is locked">
      <p className="mb-3 text-sm text-muted-foreground">
        This deployment has no administrator yet. Only its operator can create one.
      </p>
      <p className="mb-4 text-sm">
        Set the <code className="rounded bg-muted px-1 py-0.5 text-[13px]">SETUP_TOKEN</code> secret
        on the Worker, then reload this page.
      </p>
      <Button
        type="button"
        variant="outline"
        size="lg"
        onClick={() => window.location.reload()}
        className="w-full"
      >
        Reload
      </Button>
    </CardShell>
  );
}

function BootstrapForm() {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [setupToken, setSetupToken] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      // `unwrap` turns the server's `{ error }` body into the message shown.
      await unwrap(rpc.bootstrap.$post({ json: { email, password, name, setupToken } }));
      nav({ to: "/app" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Setup failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell title="Create administrator">
      <p className="mb-4 text-sm text-muted-foreground">
        First-run setup: this account becomes the system administrator. There is no public signup
        afterwards — the admin invites or creates users from the dashboard.
      </p>
      <form onSubmit={submit}>
        <Field
          label="Setup token"
          type="password"
          value={setupToken}
          onChange={setSetupToken}
          required
          autoComplete="off"
        />
        <Field label="Name" value={name} onChange={setName} required />
        <Field label="Email" type="email" value={email} onChange={setEmail} required />
        <Field
          label="Password"
          type="password"
          minLength={8}
          value={password}
          onChange={setPassword}
          required
        />
        <PrimaryButton busy={busy}>Create administrator</PrimaryButton>
      </form>
    </CardShell>
  );
}

function SignInForm({ cloudflare }: { cloudflare: boolean }) {
  const nav = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  // A refused Cloudflare sign-in comes back as /login?error=<code>. Shown on
  // the card, so it stays until read.
  const [cloudflareError] = useState(() =>
    cloudflareSignInError(new URLSearchParams(window.location.search).get("error")),
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await authClient.signIn.email({ email, password });
      if (res.error) throw new Error(res.error.message ?? "sign-in failed");
      // Better Auth's twoFactor plugin redirects to /two-factor via
      // onTwoFactorRedirect when a 2FA step is required.
      nav({ to: "/app" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  // Conditional UI: preload passkeys so the browser can offer one in the
  // email field's autofill. No-op on browsers without conditional mediation.
  useEffect(() => {
    if (
      typeof PublicKeyCredential === "undefined" ||
      !PublicKeyCredential.isConditionalMediationAvailable
    ) {
      return;
    }
    // A browser that cannot answer offers no passkey autofill.
    void PublicKeyCredential.isConditionalMediationAvailable().then(
      (ok) => {
        if (ok) void authClient.signIn.passkey({ autoFill: true });
      },
      () => {},
    );
  }, []);

  async function passkeySignIn() {
    setBusy(true);
    try {
      const res = await authClient.signIn.passkey();
      if (res?.error) throw new Error(res.error.message ?? "passkey sign-in failed");
      nav({ to: "/app" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "passkey sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell title="Sign in">
      {cloudflareError && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {cloudflareError}
        </p>
      )}
      <form onSubmit={submit}>
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          required
          autoComplete="username webauthn"
        />
        <Field
          label="Password"
          type="password"
          minLength={8}
          value={password}
          onChange={setPassword}
          required
          autoComplete="current-password webauthn"
        />
        <PrimaryButton busy={busy}>Sign in</PrimaryButton>
      </form>
      <Button
        type="button"
        variant="outline"
        size="lg"
        disabled={busy}
        onClick={passkeySignIn}
        className="mt-1 w-full"
      >
        <KeyRound className="size-4" />
        Sign in with a passkey
      </Button>
      {cloudflare && <CloudflareButton label="Admin: sign in with Cloudflare" disabled={busy} />}
      <Link
        to="/forgot-password"
        className="mt-3 block w-full text-center text-sm text-muted-foreground hover:text-foreground"
      >
        Forgot password?
      </Link>
    </CardShell>
  );
}
