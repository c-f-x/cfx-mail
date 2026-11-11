import { cn } from "@/lib/cn.ts";

// A correspondent's mark: initials on a tint derived from the address, so the
// same sender always looks the same.

const TINTS = [
  "bg-indigo-500",
  "bg-teal-500",
  "bg-orange-500",
  "bg-pink-500",
  "bg-purple-500",
  "bg-green-600",
  "bg-blue-500",
  "bg-amber-600",
  "bg-cyan-600",
  "bg-rose-500",
];

function tintFor(address: string): string {
  let hash = 5381;
  for (const ch of address.toLowerCase()) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0;
  return TINTS[hash % TINTS.length] as string;
}

function initialsFor(name: string | undefined, address: string): string {
  const source = name?.trim() || address;
  const words = source.split(/[\s._-]+/).filter((w) => /^\p{L}/u.test(w));
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  const first = Array.from(source).find((c) => /[\p{L}\p{N}]/u.test(c));
  return (first ?? "?").toUpperCase();
}

export function SenderAvatar({
  name,
  address,
  size = 36,
  className,
}: {
  name?: string;
  address: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-semibold text-white",
        tintFor(address),
        className,
      )}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
      aria-hidden="true"
    >
      {initialsFor(name, address)}
    </span>
  );
}
