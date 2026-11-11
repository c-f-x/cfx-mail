import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { BlockingSection } from "@/components/admin/blocking-section.tsx";
import { DomainsSection } from "@/components/admin/domains-section.tsx";
import { MailboxesSection } from "@/components/admin/mailboxes-section.tsx";
import { ServiceSection } from "@/components/admin/service-section.tsx";
import { UsersSection } from "@/components/admin/users-section.tsx";
import { Tabs, TabsIndicator, TabsList, TabsTab } from "@/components/ui/tabs.tsx";
import { meQuery } from "@/lib/queries.ts";

const TABS = ["domains", "users", "mailboxes", "service", "blocking"] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/app/admin")({
  // `?tab=mailboxes` is where the switcher's "Manage accounts" lands.
  validateSearch: (search: Record<string, unknown>): { tab?: Tab } =>
    TABS.includes(search.tab as Tab) ? { tab: search.tab as Tab } : {},
  component: AdminPage,
});

function AdminPage() {
  const { data: meData, isLoading } = useQuery(meQuery);
  const isAdmin = meData?.user?.role === "admin";
  const { tab: requested } = Route.useSearch();
  const [tab, setTab] = useState<Tab>(requested ?? (isAdmin ? "domains" : "mailboxes"));

  if (isLoading) {
    return <div className="p-8 text-[13px] text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 sm:px-8 sm:py-8">
        <header>
          <h1 className="text-[22px] font-semibold tracking-tight">
            {isAdmin ? "Admin" : "Accounts"}
          </h1>
          <p className="mt-1 text-[13px] text-muted-foreground">
            {isAdmin
              ? "Manage domains, users, and accounts."
              : "Accounts you own or have been given access to."}
          </p>
        </header>

        {isAdmin && (
          <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
            <TabsList>
              <TabsTab value="domains">Domains</TabsTab>
              <TabsTab value="users">Users</TabsTab>
              <TabsTab value="mailboxes">Mailboxes</TabsTab>
              <TabsTab value="service">Service</TabsTab>
              <TabsTab value="blocking">Blocking</TabsTab>
              <TabsIndicator />
            </TabsList>
          </Tabs>
        )}

        {isAdmin && tab === "domains" && <DomainsSection />}
        {isAdmin && tab === "users" && <UsersSection />}
        {isAdmin && tab === "service" && <ServiceSection />}
        {isAdmin && tab === "blocking" && <BlockingSection />}
        {(tab === "mailboxes" || !isAdmin) && <MailboxesSection />}
      </div>
    </div>
  );
}
