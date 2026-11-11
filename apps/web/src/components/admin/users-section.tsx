import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  type AdminUser,
  KindCheckboxes,
  renderKinds,
  Section,
  Select,
} from "@/components/admin/shared.tsx";
import { CopyButton } from "@/components/settings-ui.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Checkbox } from "@/components/ui/checkbox.tsx";
import { useConfirmHelpers } from "@/components/ui/confirm.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.tsx";
import { Input } from "@/components/ui/input.tsx";
import { rpc, unwrap } from "@/lib/api.ts";
import { deleteUserButton, sharedWithText } from "@/lib/delete-user.ts";
import { type InviteNotSentReason, inviteNotSentReason } from "@/lib/invite-notice.ts";
import { meQuery } from "@/lib/queries.ts";

// The wire format carries `role` as a plain string.
type AdminUserRow = Omit<AdminUser, "role"> & { role: string };

interface UserInviteRow {
  id: string;
  email: string;
  role: "admin" | "user";
  expiresAt: string;
  usedAt: string | null;
  url: string;
}

interface UnsentInvite {
  email: string;
  url: string;
  reason: InviteNotSentReason;
}

export function UsersSection() {
  const qc = useQueryClient();
  const { data: usersData } = useQuery({
    queryKey: ["admin-users"],
    queryFn: () => unwrap(rpc.users.$get()),
  });
  const { data: invitesData } = useQuery({
    queryKey: ["admin-invites"],
    queryFn: () => unwrap(rpc.users.invites.$get()),
  });
  const pendingInvites = (invitesData?.invites ?? []).filter((i) => !i.usedAt);
  // Invites and password resets are emailed from this address; without it,
  // nothing reaches the invitee.
  const { data: settingsData } = useQuery({
    queryKey: ["domains-settings"],
    queryFn: () => unwrap(rpc.domains.settings.$get()),
  });
  const noSender = settingsData !== undefined && !settingsData.authFromAddress;
  const [unsent, setUnsent] = useState<UnsentInvite | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "user">("user");
  const sendInvite = useMutation({
    mutationFn: () =>
      unwrap(rpc.users.invites.$post({ json: { email: inviteEmail, role: inviteRole } })),
    onSuccess: (res) => {
      const email = inviteEmail;
      setInviteEmail("");
      qc.invalidateQueries({ queryKey: ["admin-invites"] });
      if (res.sentEmail) toast.success(`Invite sent to ${email}`);
      else setUnsent({ email, url: res.url, reason: res.notSentReason ?? "send_failed" });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const [createEmail, setCreateEmail] = useState("");
  const [createName, setCreateName] = useState("");
  const [createPassword, setCreatePassword] = useState("");
  const [createRole, setCreateRole] = useState<"admin" | "user">("user");
  const createUser = useMutation({
    mutationFn: () =>
      unwrap(
        rpc.users.$post({
          json: {
            email: createEmail,
            name: createName,
            password: createPassword,
            role: createRole,
          },
        }),
      ),
    onSuccess: () => {
      setCreateEmail("");
      setCreateName("");
      setCreatePassword("");
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      toast.success("User created");
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <div className="space-y-5">
      <Section title="Users" description="Everyone with access to this deployment.">
        <ul className="divide-y rounded-md border">
          {(usersData?.users ?? []).map((u) => (
            <UserRow key={u.id} user={u} />
          ))}
          {usersData?.users.length === 0 && (
            <li className="px-3 py-6 text-center text-[12px] text-muted-foreground">
              No users yet.
            </li>
          )}
        </ul>
      </Section>

      <Section title="Send invite" description="User sets their own password via a one-time link.">
        {noSender && (
          <p className="mb-3 rounded-md border border-destructive/40 px-3 py-2 text-[12px] text-destructive">
            Invites and password resets cannot be emailed: no sender address is set. Add one under
            Domains, Transactional email.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="email"
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            placeholder="user@example.com"
            className="min-w-[200px] flex-1"
          />
          <Select
            value={inviteRole}
            onValueChange={(v) => setInviteRole(v as typeof inviteRole)}
            className="w-auto"
            ariaLabel="Invite role"
            options={[
              { value: "user", label: "User" },
              { value: "admin", label: "Admin" },
            ]}
          />
          <Button
            variant="primary"
            onClick={() => sendInvite.mutate()}
            disabled={!inviteEmail || sendInvite.isPending}
          >
            Send invite
          </Button>
        </div>
        {pendingInvites.length > 0 && (
          <ul className="mt-4 divide-y rounded-md border">
            {pendingInvites.map((inv) => (
              <InviteRow key={inv.id} invite={inv} />
            ))}
          </ul>
        )}
        <UnsentInviteDialog invite={unsent} onClose={() => setUnsent(null)} />
      </Section>

      <Section
        title="Create user directly"
        description="Skip the invite flow — set the user's initial password yourself and share it out of band."
      >
        <div className="grid gap-2 sm:grid-cols-2">
          <Input
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder="Name"
          />
          <Input
            type="email"
            value={createEmail}
            onChange={(e) => setCreateEmail(e.target.value)}
            placeholder="user@example.com"
          />
          <Input
            type="password"
            minLength={8}
            value={createPassword}
            onChange={(e) => setCreatePassword(e.target.value)}
            placeholder="Initial password"
          />
          <Select
            value={createRole}
            onValueChange={(v) => setCreateRole(v as typeof createRole)}
            ariaLabel="Role"
            options={[
              { value: "user", label: "User" },
              { value: "admin", label: "Admin" },
            ]}
          />
        </div>
        <div className="mt-3 flex justify-end">
          <Button
            variant="primary"
            onClick={() => createUser.mutate()}
            disabled={
              !createEmail || !createName || createPassword.length < 8 || createUser.isPending
            }
          >
            Create user
          </Button>
        </div>
      </Section>
    </div>
  );
}

function UserRow({ user }: { user: AdminUserRow }) {
  const qc = useQueryClient();
  const { data: meData } = useQuery(meQuery);
  const isMe = meData?.user?.id === user.id;
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const setRole = useMutation({
    mutationFn: (role: "admin" | "user") =>
      unwrap(rpc.users[":id"].$patch({ param: { id: user.id }, json: { role } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-users"] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <li className="px-3 py-2.5 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-medium">{user.name}</span>
            {isMe && (
              <span className="rounded border bg-muted px-1 py-0 text-[10px] font-medium text-muted-foreground">
                you
              </span>
            )}
          </div>
          <div className="truncate text-[11px] text-muted-foreground">{user.email}</div>
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={user.role}
            onValueChange={(v) => setRole.mutate(v as "admin" | "user")}
            disabled={isMe || setRole.isPending}
            className="h-7 text-[11px]"
            ariaLabel="Role"
            options={[
              { value: "user", label: "User" },
              { value: "admin", label: "Admin" },
            ]}
          />
          <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)}>
            {open ? "Hide" : "Grants"}
          </Button>
          {!isMe && (
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => setDeleting(true)}
            >
              Delete
            </Button>
          )}
        </div>
      </div>
      {open && <DomainGrantsPanel userId={user.id} />}
      {deleting && (
        <DeleteUserDialog
          user={user}
          onClose={() => {
            setDeleting(false);
            qc.invalidateQueries({ queryKey: ["admin-users"] });
          }}
        />
      )}
    </li>
  );
}

// Deleting a person: the admin ticks which of their mailboxes go with them.
// Nothing is ticked at first; every mailbox left unticked is handed to the
// admin with its mail and members, so no shared mail goes by accident.
function DeleteUserDialog({ user, onClose }: { user: AdminUserRow; onClose: () => void }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["admin-user-mailboxes", user.id],
    queryFn: () => unwrap(rpc.users[":id"].mailboxes.$get({ param: { id: user.id } })),
  });
  const owned = data?.mailboxes ?? [];
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const remove = useMutation({
    mutationFn: () =>
      unwrap(
        rpc.users[":id"].$delete({
          param: { id: user.id },
          json: { deleteMailboxIds: [...ticked] },
        }),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-mailboxes"] });
      toast.success(`${user.email} removed`);
      onClose();
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {user.email}?</DialogTitle>
          <DialogDescription>
            They lose access at once. Tick the mailboxes to delete with all their mail. The others
            are handed to you, with their mail and members; you can change their owner later.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <p className="text-[13px] text-muted-foreground">Loading mailboxes…</p>
        ) : owned.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">They own no mailboxes.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {owned.map((mb) => {
              const shared = sharedWithText(mb.sharedWith);
              return (
                <li key={mb.id}>
                  <label
                    htmlFor={`del-${mb.id}`}
                    className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-[13px] select-none"
                  >
                    <Checkbox
                      id={`del-${mb.id}`}
                      checked={ticked.has(mb.id)}
                      onCheckedChange={() => toggle(mb.id)}
                    />
                    <span className="min-w-0 flex-1 truncate">{mb.address}</span>
                    <span className="text-[11px] text-muted-foreground">
                      {mb.type}
                      {shared && ` · ${shared}`}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Cancel</Button>} />
          <Button
            variant="destructive"
            disabled={isLoading || remove.isPending}
            onClick={() => remove.mutate()}
          >
            {deleteUserButton(ticked.size)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteRow({ invite }: { invite: UserInviteRow }) {
  const qc = useQueryClient();
  const { confirm } = useConfirmHelpers();
  const revoke = useMutation({
    mutationFn: () => unwrap(rpc.users.invites[":id"].$delete({ param: { id: invite.id } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-invites"] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
      <div className="min-w-0">
        <div className="truncate font-medium text-muted-foreground">{invite.email}</div>
        <div className="text-[11px] text-muted-foreground">
          {invite.role} · expires {new Date(invite.expiresAt).toLocaleString()}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <CopyButton value={invite.url} label="Copy link" />
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:bg-destructive/10 hover:text-destructive"
          onClick={async () => {
            if (
              await confirm({
                title: `Revoke invite for ${invite.email}?`,
                description: "The invite link stops working immediately.",
                confirmLabel: "Revoke",
                destructive: true,
              })
            )
              revoke.mutate();
          }}
        >
          Revoke
        </Button>
      </div>
    </li>
  );
}

// An invite whose email did not go out: say so, say why, and hand over the
// link. It stays until closed, unlike a toast that fades before it is read.
function UnsentInviteDialog({
  invite,
  onClose,
}: {
  invite: UnsentInvite | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={invite !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>The invite email to {invite?.email} was not sent</DialogTitle>
          <DialogDescription>{invite && inviteNotSentReason(invite.reason)}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <code className="flex-1 truncate rounded border bg-muted px-2 py-1.5 font-mono text-[12px]">
            {invite?.url}
          </code>
          {invite && <CopyButton value={invite.url} label="Copy link" />}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="primary">Done</Button>} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DomainGrantsPanel({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const { data: domainsData } = useQuery({
    queryKey: ["domains"],
    queryFn: () => unwrap(rpc.domains.$get()),
  });
  const { data: grantsData } = useQuery({
    queryKey: ["user-grants", userId],
    queryFn: () => unwrap(rpc.users[":id"]["domain-grants"].$get({ param: { id: userId } })),
  });

  const setGrant = useMutation({
    mutationFn: ({ domainId, allowedKinds }: { domainId: string; allowedKinds: number }) =>
      unwrap(
        rpc.users[":id"]["domain-grants"][":domainId"].$put({
          param: { id: userId, domainId },
          json: { userId, allowedKinds },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-grants", userId] }),
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed"),
  });

  const grantByDomain = new Map(
    (grantsData?.grants ?? []).map((g) => [g.domainId, g.allowedKinds]),
  );

  return (
    <div className="mt-3 rounded-md border bg-muted/30 p-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        Per-domain mailbox-kind grants
      </div>
      <ul className="divide-y rounded-md border bg-card">
        {(domainsData?.domains ?? []).map((d) => {
          const kinds = grantByDomain.get(d.id) ?? 0;
          return (
            <li
              key={d.id}
              className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]"
            >
              <div className="min-w-0 flex-1 truncate">
                <div className="truncate font-medium">{d.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  domain allows: {d.allowedKinds ? renderKinds(d.allowedKinds) : "none"}
                </div>
              </div>
              <KindCheckboxes
                value={kinds & d.allowedKinds}
                onChange={(v) =>
                  setGrant.mutate({ domainId: d.id, allowedKinds: v & d.allowedKinds })
                }
              />
            </li>
          );
        })}
        {domainsData?.domains.length === 0 && (
          <li className="px-3 py-3 text-center text-[11px] text-muted-foreground">
            No domains configured.
          </li>
        )}
      </ul>
    </div>
  );
}
