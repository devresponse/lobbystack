"use client";

import { Check, ChevronDown, Plus, Search, Settings2, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { RECEPTIONIST_PICKER_SEARCH_FROM } from "@lobbystack/shared";

import { intlLocale } from "@/lib/locale";
import { cn } from "@/lib/utils";
import { ReceptionistAvatar } from "./receptionist-avatar";
import { foldForSearch, receptionistMatches, type ReceptionistOption } from "./receptionist-choices";

// The dropdown for one receptionist: which one AI settings edits, who answers
// a number, a widget key, a QR link or a website rule, who answers a test
// call, and the filters on record pages ("All receptionists" first). It
// follows the select-only combobox pattern: the button keeps the focus and
// names the highlighted choice with aria-activedescendant. From 8
// receptionists the open list starts with a search box, which takes the focus
// and filters by name and "What it helps with". With one receptionist there is
// nothing to choose, so it renders nothing unless alwaysShow.

export const RECEPTIONISTS_PAGE_PATH = "/agent/receptionists";

type Choice =
  | { key: string; kind: "all"; value: null }
  | { key: string; kind: "receptionist"; value: string; receptionist: ReceptionistOption }
  | { key: string; kind: "add" | "manage"; value: null };

export type ReceptionistSelectProps = {
  label: string;
  /** Keeps the label for screen readers only, where the screen already says what the dropdown is for. */
  hideLabel?: boolean;
  receptionists: ReceptionistOption[];
  /** The receptionist chosen; null is "All receptionists" when allLabel is given. */
  value: string | null;
  onChange: (receptionistId: string | null) => void;
  /** Lists "All receptionists" first, as null. */
  allLabel?: string;
  /** Owners and admins: Add receptionist and Manage receptionists at the bottom of the list. */
  showManage?: boolean;
  disabled?: boolean;
  /** Shows the dropdown with one receptionist too. */
  alwaysShow?: boolean;
  /** Which edge of the button the open list lines up with; end for a dropdown near the right of the screen. */
  align?: "start" | "end";
  /** sm matches the small buttons of a toolbar. */
  size?: "default" | "sm" | undefined;
  /** A number at the end of each line, such as the open questions each receptionist heard. */
  counts?: ReceptionistCounts | undefined;
  className?: string | undefined;
};

export type ReceptionistCounts = {
  byReceptionist: Readonly<Record<string, number>>;
  /** The number for "All receptionists". */
  all?: number | undefined;
  /** Words a number for screen readers, such as "3 open questions". */
  label: (count: number) => string;
};

export function ReceptionistSelect({ label, hideLabel = false, receptionists, value, onChange, allLabel, showManage = false, disabled = false, alwaysShow = false, align = "start", size = "default", counts, className }: ReceptionistSelectProps) {
  const { i18n, t } = useTranslation("receptionists");
  const router = useRouter();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const searchable = receptionists.length >= RECEPTIONIST_PICKER_SEARCH_FROM;
  const labelId = `${id}-label`;
  const valueId = `${id}-value`;
  const listId = `${id}-list`;
  const optionId = (index: number) => `${id}-option-${index}`;

  const choices = useMemo<Choice[]>(() => {
    const searching = query.trim().length > 0;
    return [
      ...(allLabel && !searching ? [{ key: "all", kind: "all", value: null } as const] : []),
      ...receptionists.filter((receptionist) => receptionistMatches(receptionist, query)).map((receptionist) => ({ key: receptionist.id, kind: "receptionist", value: receptionist.id, receptionist } as const)),
      ...(showManage ? [{ key: "add", kind: "add", value: null } as const, { key: "manage", kind: "manage", value: null } as const] : []),
    ];
  }, [allLabel, query, receptionists, showManage]);
  const matches = choices.filter((choice) => choice.kind !== "add" && choice.kind !== "manage").length;
  const selected = receptionists.find((receptionist) => receptionist.id === value);

  // A click anywhere else closes the list.
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useEffect(() => {
    if (open && searchable) searchField.current?.focus();
  }, [open, searchable]);

  // Keeps the highlighted choice in view as the arrow keys move through a long list.
  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open]);

  function isChosen(choice: Choice): boolean {
    return (choice.kind === "receptionist" && choice.value === value) || (choice.kind === "all" && value === null);
  }

  function show(at: "chosen" | "first" | "last" = "chosen") {
    if (disabled) return;
    const chosen = choices.findIndex(isChosen);
    setActive(at === "first" ? 0 : at === "last" ? choices.length - 1 : Math.max(chosen, 0));
    setOpen(true);
  }

  function close(focusButton = true) {
    setOpen(false);
    setQuery("");
    if (focusButton) button.current?.focus();
  }

  function pick(choice: Choice | undefined) {
    if (!choice) return;
    if (choice.kind === "add" || choice.kind === "manage") {
      close(false);
      router.push(choice.kind === "add" ? `${RECEPTIONISTS_PAGE_PATH}?add=1` : RECEPTIONISTS_PAGE_PATH);
      return;
    }
    if (choice.value !== value) onChange(choice.value);
    close();
  }

  // Jumps to the next receptionist whose name starts with what was typed in the last moment.
  function typeAhead(character: string) {
    const now = Date.now();
    typed.current = { text: now - typed.current.at < 700 ? typed.current.text + character : character, at: now };
    const text = foldForSearch(typed.current.text);
    const from = open ? active + (typed.current.text.length === 1 ? 1 : 0) : 0;
    for (let step = 0; step < choices.length; step += 1) {
      const index = (from + step) % choices.length;
      const choice = choices[index]!;
      if (choice.kind === "receptionist" && foldForSearch(choice.receptionist.name).startsWith(text)) {
        setActive(index);
        if (!open) setOpen(true);
        return;
      }
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const fromSearch = event.currentTarget === searchField.current;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " ", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        show(event.key === "Home" ? "first" : event.key === "End" ? "last" : "chosen");
      } else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey && !disabled) {
        // A letter opens the list at the first receptionist it starts, or starts the search.
        if (!searchable) typeAhead(event.key);
        else {
          event.preventDefault();
          setQuery(event.key);
          setActive(0);
          setOpen(true);
        }
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((index) => Math.min(index + 1, choices.length - 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        if (event.altKey) pick(choices[active]);
        else setActive((index) => Math.max(index - 1, 0));
        return;
      case "Home":
      case "End":
        if (fromSearch) return;
        event.preventDefault();
        setActive(event.key === "Home" ? 0 : choices.length - 1);
        return;
      case "PageDown":
      case "PageUp":
        event.preventDefault();
        setActive((index) => Math.min(Math.max(index + (event.key === "PageDown" ? 10 : -10), 0), choices.length - 1));
        return;
      case "Enter":
        event.preventDefault();
        pick(choices[active]);
        return;
      case " ":
        if (fromSearch) return;
        event.preventDefault();
        pick(choices[active]);
        return;
      case "Escape":
        event.preventDefault();
        close();
        return;
      default:
        if (!fromSearch && event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey) typeAhead(event.key);
    }
  }

  if (receptionists.length <= 1 && !alwaysShow) return null;
  const activeId = open && choices[active] ? optionId(active) : undefined;
  const countOf = (choice: Choice): number | undefined => !counts ? undefined : choice.kind === "all" ? counts.all : choice.kind === "receptionist" ? counts.byReceptionist[choice.value] ?? 0 : undefined;
  const locale = intlLocale(i18n.language);

  return (
    // Tabbing out of the button or the search box closes the list.
    <div
      ref={root}
      className={cn("relative flex min-w-0 flex-col gap-1.5", className)}
      onBlur={(event) => { if (open && !root.current?.contains(event.relatedTarget as Node | null)) { setOpen(false); setQuery(""); } }}
    >
      <span id={labelId} className={hideLabel ? "sr-only" : "text-sm font-medium"}>{label}</span>
      <button
        ref={button}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-labelledby={`${labelId} ${valueId}`}
        aria-activedescendant={searchable ? undefined : activeId}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKeyDown}
        className={cn("flex w-full min-w-0 items-center gap-2 rounded-xl border border-border bg-background px-2.5 text-left text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50", size === "sm" ? "min-h-8 py-1" : "min-h-10 py-1.5")}
      >
        <span id={valueId} className="flex min-w-0 flex-1 items-center gap-2">
          {selected ? (
            <>
              <ReceptionistAvatar id={selected.id} name={selected.name} size="sm" />
              <span className="truncate font-medium">{selected.name}</span>
              {selected.status === "paused" ? <span className="flex-none text-xs text-muted-foreground">({t("picker.paused")})</span> : null}
            </>
          ) : value === null && allLabel ? (
            <>
              <Users aria-hidden="true" className="size-4 flex-none text-muted-foreground" />
              <span className="truncate font-medium">{allLabel}</span>
            </>
          ) : (
            <span className="truncate text-muted-foreground">{value ? t("picker.unknown") : t("picker.choose")}</span>
          )}
        </span>
        <ChevronDown aria-hidden="true" className={cn("size-4 flex-none text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className={cn("absolute top-full z-50 mt-1 flex max-h-[min(26rem,70svh)] w-max min-w-full max-w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg", align === "end" ? "right-0" : "left-0")}>
          {searchable ? (
            <div className="flex items-center gap-2 border-b border-border px-2.5">
              <Search aria-hidden="true" className="size-4 flex-none text-muted-foreground" />
              <input
                ref={searchField}
                type="text"
                role="combobox"
                aria-label={t("picker.search")}
                aria-autocomplete="list"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={activeId}
                autoComplete="off"
                spellCheck={false}
                value={query}
                placeholder={t("picker.search")}
                onChange={(event) => { setQuery(event.target.value); setActive(0); }}
                onKeyDown={onKeyDown}
                className="min-h-10 w-full min-w-0 border-0 bg-transparent text-sm outline-none"
              />
            </div>
          ) : null}
          <ul id={listId} role="listbox" aria-labelledby={labelId} className="flex flex-col overflow-y-auto py-1">
            {choices.map((choice, index) => (
              <Option
                key={choice.key}
                id={optionId(index)}
                active={index === active}
                selected={isChosen(choice)}
                separated={(choice.kind === "add") && index > 0}
                count={countOf(choice)}
                countLabel={counts?.label}
                locale={locale}
                onHover={() => setActive(index)}
                onPick={() => pick(choice)}
              >
                {choice.kind === "receptionist" ? <ReceptionistLine receptionist={choice.receptionist} defaultLabel={t("picker.default")} pausedLabel={t("picker.paused")} />
                  : choice.kind === "all" ? <><Users aria-hidden="true" className="size-4 flex-none text-muted-foreground" /><span className="flex-1 font-medium">{allLabel}</span></>
                    : choice.kind === "add" ? <><Plus aria-hidden="true" className="size-4 flex-none text-muted-foreground" /><span className="flex-1">{t("picker.add")}</span></>
                      : <><Settings2 aria-hidden="true" className="size-4 flex-none text-muted-foreground" /><span className="flex-1">{t("picker.manage")}</span></>}
              </Option>
            ))}
          </ul>
          {matches === 0 ? <p role="status" className="px-3 py-2 text-sm text-muted-foreground">{t("picker.noMatches")}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function Option({ id, active, selected, separated, count, countLabel, locale, onHover, onPick, children }: { id: string; active: boolean; selected: boolean; separated: boolean; count: number | undefined; countLabel: ((count: number) => string) | undefined; locale: string; onHover: () => void; onPick: () => void; children: ReactNode }) {
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      data-active={active || undefined}
      // The button or the search box keeps the focus; a click only picks.
      onMouseDown={(event) => event.preventDefault()}
      onMouseMove={onHover}
      onClick={onPick}
      onKeyDown={(event) => { if (event.key === "Enter") onPick(); }}
      className={cn("flex cursor-pointer items-center gap-2 px-2.5 py-2 text-sm outline-none data-[active]:bg-muted", separated && "mt-1 border-t border-border pt-2.5")}
    >
      {children}
      {count !== undefined ? (
        <span className="flex-none text-xs tabular-nums text-muted-foreground">
          <span aria-hidden="true">{count.toLocaleString(locale)}</span>
          {countLabel ? <span className="sr-only">{countLabel(count)}</span> : null}
        </span>
      ) : null}
      {selected ? <Check aria-hidden="true" className="size-4 flex-none" /> : <span aria-hidden="true" className="size-4 flex-none" />}
    </li>
  );
}

/** A receptionist in a list: initials, name, whether it is the default or paused, and what it helps with. */
export function ReceptionistLine({ receptionist, defaultLabel, pausedLabel }: { receptionist: ReceptionistOption; defaultLabel: string; pausedLabel: string }) {
  return (
    <>
      <ReceptionistAvatar id={receptionist.id} name={receptionist.name} />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="font-medium [overflow-wrap:anywhere]">{receptionist.name}</span>
          {receptionist.isDefault ? <span className="flex-none rounded-full bg-muted px-1.5 py-px text-[11px] text-muted-foreground">{defaultLabel}</span> : null}
          {receptionist.status === "paused" ? <span className="flex-none rounded-full border border-border px-1.5 py-px text-[11px] text-muted-foreground">{pausedLabel}</span> : null}
        </span>
        {receptionist.description ? <span className="line-clamp-2 text-xs text-muted-foreground">{receptionist.description}</span> : null}
      </span>
    </>
  );
}
