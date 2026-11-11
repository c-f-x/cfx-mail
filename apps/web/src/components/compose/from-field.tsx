import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { Field, FieldContent, fieldLabelClass } from "@/components/ui/field.tsx";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.tsx";
import { accountName } from "@/lib/accounts.ts";
import type { MailboxSummary } from "@/lib/queries.ts";
import { AccountTile } from "../account-switcher.tsx";
import { plusBase } from "./compose-utils.ts";
import type { FromAddress } from "./use-from-address.ts";

// The "From" row: sendable-address picker plus the custom "+tag" sub-address
// popover.
export function FromField({ from, sendable }: { from: FromAddress; sendable: MailboxSummary[] }) {
  const {
    mailboxId,
    isDefaultSender,
    setMailboxId,
    setFromAddress,
    baseAddr,
    fromOptions,
    currentFrom,
    plusOpen,
    setPlusOpen,
    plusTag,
    setPlusTag,
    applyPlusTag,
  } = from;
  return (
    <Field className="flex-wrap gap-y-0">
      <span className={fieldLabelClass}>From</span>
      <FieldContent className="flex min-w-0 flex-1 items-start gap-1">
        <Select
          value={currentFrom}
          onValueChange={(v) => {
            const opt = fromOptions.find((o) => o.address === v);
            if (!opt) return;
            setMailboxId(opt.mailboxId);
            // Track an override only for a plus-alias; a base address is null.
            setFromAddress(
              opt.address.toLowerCase() === baseAddr(opt.mailboxId).toLowerCase()
                ? null
                : opt.address,
            );
          }}
        >
          <SelectTrigger
            aria-label="From address"
            className="h-auto w-auto flex-1 justify-between gap-1 border-0 bg-transparent px-0 py-0.5 text-left text-[13px] leading-5 shadow-none hover:bg-transparent focus-visible:ring-0"
          >
            <SelectValue>
              {(value) => (
                <SenderLabel
                  address={(value as string) ?? ""}
                  account={sendable.find((m) => m.id === mailboxId)}
                />
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {fromOptions.map((o) => (
              <SelectItem key={o.address} value={o.address}>
                <SenderLabel
                  address={o.address}
                  account={sendable.find((m) => m.id === o.mailboxId)}
                />
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Popover
          open={plusOpen}
          onOpenChange={(open) => {
            setPlusOpen(open);
            if (open) {
              const local = plusBase(currentFrom);
              setPlusTag(
                local && currentFrom.toLowerCase() !== local
                  ? (currentFrom.slice(currentFrom.indexOf("+") + 1).split("@")[0] ?? "")
                  : "",
              );
            }
          }}
        >
          <PopoverTrigger
            render={
              <button
                type="button"
                aria-label="Custom sub-address"
                className="mt-0.5 grid size-5 shrink-0 place-items-center rounded text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/45"
              >
                <Plus className="size-3.5" />
              </button>
            }
          />
          <PopoverContent side="bottom" align="start" className="w-72 p-2">
            <span className="mb-1.5 block px-0.5 text-[11px] text-muted-foreground">
              Custom sub-address
            </span>
            {(() => {
              const base = baseAddr(mailboxId);
              const at = base.lastIndexOf("@");
              const local = at > 0 ? base.slice(0, at) : base;
              const domain = at > 0 ? base.slice(at + 1) : "";
              return (
                <InputGroup>
                  <InputGroupAddon className="gap-0">
                    <InputGroupText>{local}+</InputGroupText>
                  </InputGroupAddon>
                  <InputGroupInput
                    autoFocus
                    value={plusTag}
                    onChange={(e) => setPlusTag(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        applyPlusTag();
                      }
                    }}
                    placeholder="tag"
                    aria-label="Sub-address tag"
                    className="px-1"
                  />
                  <InputGroupAddon align="end">
                    <InputGroupText>@{domain}</InputGroupText>
                  </InputGroupAddon>
                </InputGroup>
              );
            })()}
            <Button variant="primary" size="sm" className="mt-2 w-full" onClick={applyPlusTag}>
              Use address
            </Button>
          </PopoverContent>
        </Popover>
      </FieldContent>
      {isDefaultSender && (
        <p className="basis-full pb-0.5 pl-16 text-[11px] text-muted-foreground">
          Your default account. Pick another above if this is for a different project.
        </p>
      )}
    </Field>
  );
}

// "Name <address>" with the account's domain tile, so the sending account is
// recognisable at a glance, the same way the switcher shows it.
function SenderLabel({ address, account }: { address: string; account?: MailboxSummary }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      {account && <AccountTile account={account} className="size-5 rounded text-[10px]" />}
      {account && <span className="shrink-0 font-medium">{accountName(account)}</span>}
      <span className="truncate font-mono text-[12px] text-muted-foreground tracking-normal">
        {account ? `<${address}>` : address}
      </span>
    </span>
  );
}
