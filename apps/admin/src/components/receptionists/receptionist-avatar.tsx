import { receptionistInitials } from "@lobbystack/shared";

import { cn } from "@/lib/utils";

// Receptionists are told apart by name and initials, in a few muted colours.
// A colour each stops working past 8 receptionists, so colour never carries
// meaning on its own: the name is always beside it.

const TONES = [
  "bg-sky-100 text-sky-950 dark:bg-sky-900/60 dark:text-sky-50",
  "bg-emerald-100 text-emerald-950 dark:bg-emerald-900/60 dark:text-emerald-50",
  "bg-amber-100 text-amber-950 dark:bg-amber-900/60 dark:text-amber-50",
  "bg-rose-100 text-rose-950 dark:bg-rose-900/60 dark:text-rose-50",
  "bg-violet-100 text-violet-950 dark:bg-violet-900/60 dark:text-violet-50",
  "bg-stone-200 text-stone-950 dark:bg-stone-700/70 dark:text-stone-50",
] as const;

/** The same tone for a receptionist on every screen, from its id. */
export function receptionistTone(id: string): string {
  let hash = 0;
  for (const character of id) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return TONES[hash % TONES.length]!;
}

export function ReceptionistAvatar({ id, name, size = "md", className }: { id: string; name: string; size?: "sm" | "md"; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex flex-none items-center justify-center rounded-full font-semibold",
        size === "sm" ? "size-5 text-[10px]" : "size-7 text-xs",
        receptionistTone(id),
        className,
      )}
    >
      {receptionistInitials(name)}
    </span>
  );
}
