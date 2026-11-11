import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { FolderPlus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { rpc, unwrap } from "@/lib/api.ts";
import { cn } from "@/lib/cn.ts";
import { type FolderRow, foldersQuery } from "@/lib/queries.ts";
import { keys } from "@/lib/query-keys.ts";
import { railRowActiveClass, railRowClass } from "./mail-views.ts";
import { Button } from "./ui/button.tsx";
import { ColorField, DEFAULT_COLOR } from "./ui/color-field.tsx";
import { useConfirmHelpers } from "./ui/confirm.tsx";
import { Input } from "./ui/input.tsx";

export function FoldersNav({ onClose }: { onClose?: () => void }) {
  const { data } = useQuery(foldersQuery);
  const folders = data?.folders ?? [];
  const qc = useQueryClient();
  const nav = useNavigate();
  const { confirmDelete } = useConfirmHelpers();
  const params = useParams({ strict: false });
  const activeId = (params as { folderId?: string }).folderId;

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(DEFAULT_COLOR);

  const create = useMutation({
    mutationFn: () => unwrap(rpc.folders.$post({ json: { name: name.trim(), color } })),
    onSuccess: () => {
      setCreating(false);
      setName("");
      setColor(DEFAULT_COLOR);
      qc.invalidateQueries({ queryKey: keys.folders() });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed to create"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => unwrap(rpc.folders[":id"].$delete({ param: { id } })),
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: keys.folders() });
      if (activeId === id) nav({ to: "/app" });
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : "Failed to delete"),
  });

  async function onDelete(f: FolderRow) {
    const ok = await confirmDelete(
      `folder "${f.name}"`,
      "The folder is removed; its conversations return to their mailboxes.",
    );
    if (ok) remove.mutate(f.id);
  }

  return (
    <section className="mt-5">
      <h3 className="mb-1 flex h-6 items-center justify-between gap-1.5 pr-1 pl-2.5 font-semibold text-[10px] text-muted-foreground uppercase tracking-wider">
        Folders
        <button
          type="button"
          onClick={() => setCreating((v) => !v)}
          aria-label="New folder"
          title="New folder"
          className="grid size-6 place-items-center rounded text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <FolderPlus className="h-3.5 w-3.5" />
        </button>
      </h3>

      {creating && (
        <form
          className="mx-1 mb-2 space-y-2 rounded-md border bg-card p-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <Input
            ref={(el) => el?.focus()}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setCreating(false);
            }}
            placeholder="Folder name"
            maxLength={64}
            className="h-7 text-[13px]"
          />
          <ColorField color={color} onChange={setColor} />
          <div className="flex gap-2">
            <Button
              type="submit"
              variant="primary"
              size="sm"
              className="flex-1"
              disabled={!name.trim() || create.isPending}
            >
              {create.isPending ? "Creating…" : "Create"}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      <ul className="flex flex-col gap-px">
        {folders.map((f) => (
          <li key={f.id} className="group/row relative">
            <Link
              to="/app/folder/$folderId"
              params={{ folderId: f.id }}
              onClick={() => onClose?.()}
              aria-current={activeId === f.id ? "page" : undefined}
              className={cn(railRowClass, activeId === f.id && railRowActiveClass)}
            >
              <span
                className="mx-[3px] size-2.5 shrink-0 rounded-sm"
                style={{ backgroundColor: f.color }}
              />
              <span className={cn("truncate", f.unread > 0 && "font-semibold")}>{f.name}</span>
              {f.unread > 0 && (
                <span className="ml-auto font-semibold text-[11px] tabular-nums group-hover/row:invisible">
                  {f.unread}
                  <span className="sr-only"> unread</span>
                </span>
              )}
            </Link>
            <button
              type="button"
              aria-label={`Delete ${f.name}`}
              title="Delete folder"
              disabled={remove.isPending}
              onClick={() => onDelete(f)}
              className="absolute inset-y-0 right-1 my-auto hidden h-6 w-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive group-hover/row:flex"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
