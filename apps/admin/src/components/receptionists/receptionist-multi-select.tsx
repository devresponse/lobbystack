"use client";

import { Check, ChevronDown, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";

import { RECEPTIONIST_PICKER_SEARCH_FROM } from "@lobbystack/shared";

import { cn } from "@/lib/utils";
import { ReceptionistAvatar } from "./receptionist-avatar";
import { receptionistMatches, type ReceptionistOption } from "./receptionist-choices";
import { ReceptionistLine } from "./receptionist-select";

// The multiselect box for several receptionists: who an article is for, who
// an answer is for, which receptionists the business page lists. Chosen
// receptionists show as removable tokens; past 3 it shows 2 and "+N more".
// The open box has a search field from 8 receptionists, checkboxes, Select
// all shown and Clear, and keeps the chosen ones on top: in the order they
// had when it opened, so a row never moves under the pointer. It follows the
// combobox pattern with a multiselectable listbox. With one receptionist
// there is nothing to choose, so it renders nothing unless alwaysShow.

const TOKENS_SHOWN = 3;

export type ReceptionistMultiSelectProps = {
  label: string;
  hideLabel?: boolean;
  receptionists: ReceptionistOption[];
  value: string[];
  onChange: (receptionistIds: string[]) => void;
  /** Sums the choice up beside the label, such as "Available to 7 of 24 receptionists". */
  summary?: (chosen: number, total: number) => string;
  disabled?: boolean;
  invalid?: boolean;
  /** The id of a message about the field, such as why it can't be empty. */
  describedBy?: string;
  alwaysShow?: boolean;
  className?: string | undefined;
};

export function ReceptionistMultiSelect({ label, hideLabel = false, receptionists, value, onChange, summary, disabled = false, invalid = false, describedBy, alwaysShow = false, className }: ReceptionistMultiSelectProps) {
  const { t } = useTranslation("receptionists");
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [order, setOrder] = useState<string[]>([]);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const searchable = receptionists.length >= RECEPTIONIST_PICKER_SEARCH_FROM;
  const labelId = `${id}-label`;
  const summaryId = `${id}-summary`;
  const listId = `${id}-list`;
  const optionId = (index: number) => `${id}-option-${index}`;

  const byId = useMemo(() => new Map(receptionists.map((receptionist) => [receptionist.id, receptionist])), [receptionists]);
  // Ids the business doesn't list any more (archived receptionists) are kept out of the count and the tokens.
  const chosen = receptionists.filter((receptionist) => value.includes(receptionist.id));
  const shown = useMemo(() => {
    const ordered = order.length ? order.map((receptionistId) => byId.get(receptionistId)).filter((receptionist): receptionist is ReceptionistOption => Boolean(receptionist)) : receptionists;
    // A receptionist added while the box is open goes last.
    const rest = receptionists.filter((receptionist) => !order.includes(receptionist.id));
    return [...ordered, ...(order.length ? rest : [])].filter((receptionist) => receptionistMatches(receptionist, query));
  }, [byId, order, query, receptionists]);

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

  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, open]);

  function show() {
    if (disabled) return;
    // The chosen ones on top, as they stand now.
    setOrder([...receptionists.filter((receptionist) => value.includes(receptionist.id)), ...receptionists.filter((receptionist) => !value.includes(receptionist.id))].map((receptionist) => receptionist.id));
    setActive(0);
    setOpen(true);
  }

  function close(focusButton = true) {
    setOpen(false);
    setQuery("");
    if (focusButton) button.current?.focus();
  }

  /** Keeps the business's order, and any ids the box doesn't list, so saving never drops them by accident. */
  function emit(next: Set<string>) {
    const unlisted = value.filter((receptionistId) => !byId.has(receptionistId));
    onChange([...receptionists.filter((receptionist) => next.has(receptionist.id)).map((receptionist) => receptionist.id), ...unlisted]);
  }

  function toggle(receptionistId: string) {
    const next = new Set(value.filter((chosenId) => byId.has(chosenId)));
    if (next.has(receptionistId)) next.delete(receptionistId);
    else next.add(receptionistId);
    emit(next);
  }

  function selectShown() {
    emit(new Set([...value.filter((chosenId) => byId.has(chosenId)), ...shown.map((receptionist) => receptionist.id)]));
  }

  function clear() {
    emit(new Set());
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    const fromSearch = event.currentTarget === searchField.current;
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        show();
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive((index) => Math.min(index + 1, shown.length - 1));
        return;
      case "ArrowUp":
        event.preventDefault();
        setActive((index) => Math.max(index - 1, 0));
        return;
      case "Home":
      case "End":
        if (fromSearch) return;
        event.preventDefault();
        setActive(event.key === "Home" ? 0 : shown.length - 1);
        return;
      case "Enter":
        event.preventDefault();
        if (shown[active]) toggle(shown[active]!.id);
        return;
      case " ":
        if (fromSearch) return;
        event.preventDefault();
        if (shown[active]) toggle(shown[active]!.id);
        return;
      case "Escape":
        event.preventDefault();
        close();
        return;
      case "a":
        if ((event.ctrlKey || event.metaKey) && !fromSearch) {
          event.preventDefault();
          selectShown();
        }
        return;
      default:
    }
  }

  if (receptionists.length <= 1 && !alwaysShow) return null;
  const tokens = chosen.length > TOKENS_SHOWN ? chosen.slice(0, TOKENS_SHOWN - 1) : chosen;
  const hidden = chosen.length - tokens.length;
  const activeId = open && shown[active] ? optionId(active) : undefined;
  const summaryText = summary ? summary(chosen.length, receptionists.length) : t("multi.summary", { chosen: chosen.length, count: receptionists.length });

  return (
    <div
      ref={root}
      className={cn("relative flex min-w-0 flex-col gap-1.5", className)}
      onBlur={(event) => { if (open && !root.current?.contains(event.relatedTarget as Node | null)) { setOpen(false); setQuery(""); } }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <span id={labelId} className={hideLabel ? "sr-only" : "text-sm font-medium"}>{label}</span>
        <span id={summaryId} className="text-xs text-muted-foreground">{summaryText}</span>
      </div>
      <div className={cn("flex min-h-10 flex-wrap items-center gap-1.5 rounded-xl border bg-background p-1.5", invalid ? "border-destructive" : "border-border", disabled && "opacity-50")}>
        {tokens.map((receptionist) => (
          <span key={receptionist.id} className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-muted py-0.5 pr-0.5 pl-1 text-xs">
            <ReceptionistAvatar id={receptionist.id} name={receptionist.name} size="sm" />
            <span className="truncate font-medium">{receptionist.name}</span>
            <button
              type="button"
              disabled={disabled}
              aria-label={t("multi.remove", { name: receptionist.name })}
              onClick={() => toggle(receptionist.id)}
              className="inline-flex size-5 flex-none items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X aria-hidden="true" className="size-3" />
            </button>
          </span>
        ))}
        {hidden > 0 ? (
          <button type="button" disabled={disabled} onClick={() => (open ? close() : show())} className="rounded-full border border-border px-2 py-0.5 text-xs font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
            {t("multi.more", { count: hidden })}
          </button>
        ) : null}
        <button
          ref={button}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-labelledby={`${labelId} ${summaryId}`}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          aria-activedescendant={searchable ? undefined : activeId}
          disabled={disabled}
          onClick={() => (open ? close() : show())}
          onKeyDown={onKeyDown}
          className="ml-auto flex min-h-7 items-center gap-1 rounded-lg px-2 text-sm text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
        >
          <span>{chosen.length ? t("multi.change") : t("multi.none")}</span>
          <ChevronDown aria-hidden="true" className={cn("size-4 transition-transform", open && "rotate-180")} />
        </button>
      </div>
      {open ? (
        <div className="absolute top-full right-0 left-0 z-50 mt-1 flex max-h-[min(28rem,70svh)] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg">
          {searchable ? (
            <div className="flex items-center gap-2 border-b border-border px-2.5">
              <Search aria-hidden="true" className="size-4 flex-none text-muted-foreground" />
              <input
                ref={searchField}
                type="text"
                role="combobox"
                aria-label={t("multi.search")}
                aria-autocomplete="list"
                aria-expanded="true"
                aria-controls={listId}
                aria-activedescendant={activeId}
                autoComplete="off"
                spellCheck={false}
                value={query}
                placeholder={t("multi.search")}
                onChange={(event) => { setQuery(event.target.value); setActive(0); }}
                onKeyDown={onKeyDown}
                className="min-h-10 w-full min-w-0 border-0 bg-transparent text-sm outline-none"
              />
            </div>
          ) : null}
          <div className="flex items-center justify-between gap-2 border-b border-border px-2.5 py-1.5">
            <button type="button" onClick={selectShown} disabled={!shown.some((receptionist) => !value.includes(receptionist.id))} className="rounded-md px-1.5 py-1 text-xs font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{t("multi.selectShown")}</button>
            <button type="button" onClick={clear} disabled={!chosen.length} className="rounded-md px-1.5 py-1 text-xs font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">{t("multi.clear")}</button>
          </div>
          <ul id={listId} role="listbox" aria-multiselectable="true" aria-labelledby={labelId} className="flex flex-col overflow-y-auto py-1">
            {shown.map((receptionist, index) => {
              const isChosen = value.includes(receptionist.id);
              return (
                <li
                  key={receptionist.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={isChosen}
                  tabIndex={-1}
                  data-active={index === active || undefined}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setActive(index)}
                  onClick={() => toggle(receptionist.id)}
                  onKeyDown={(event) => { if (event.key === "Enter") toggle(receptionist.id); }}
                  className="flex cursor-pointer items-center gap-2 px-2.5 py-2 text-sm outline-none data-[active]:bg-muted"
                >
                  <span aria-hidden="true" className={cn("inline-flex size-4 flex-none items-center justify-center rounded border", isChosen ? "border-primary bg-primary text-primary-foreground" : "border-input bg-background")}>
                    {isChosen ? <Check className="size-3" /> : null}
                  </span>
                  <ReceptionistLine receptionist={receptionist} defaultLabel={t("picker.default")} pausedLabel={t("picker.paused")} />
                </li>
              );
            })}
          </ul>
          {shown.length ? null : <p role="status" className="px-3 py-2 text-sm text-muted-foreground">{t("picker.noMatches")}</p>}
        </div>
      ) : null}
    </div>
  );
}
