"use client";

import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { receptionistInitials, RECEPTIONIST_PICKER_SEARCH_FROM } from "@lobbystack/shared";

import type { PickerReceptionist } from "@/lib/public-profile-page";

// The visitor's dropdown on a business's public pages: who answers this page,
// and the business's other listed receptionists, each a link to its own page.
// It lists the default receptionist first, then the order the Receptionists
// page sets, with what each one helps with under its name, and from 8 a search
// box filters by both. The page renders on the server with no translation code
// in the browser, so its words come in as props.

export type ReceptionistPickerLabels = {
  /** "You're talking to", above the button. */
  label: string;
  /** The list's name for screen readers. */
  choose: string;
  search: string;
  noMatches: string;
  /** Marks the receptionist that answers this page. */
  current: string;
};

function Badge({ name, large = false }: { name: string; large?: boolean }) {
  return (
    <span aria-hidden="true" className={`inline-flex flex-none items-center justify-center rounded-full bg-[#000] font-bold text-[#fff] ${large ? "size-10 text-[15px]" : "size-9 text-sm"}`}>
      {receptionistInitials(name)}
    </span>
  );
}

/** Lower case without accents, so a search for "recepcion" finds "Recepción". */
const folded = (text: string) => text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase();

export function ReceptionistPicker({ current, choices, labels }: { current: PickerReceptionist; choices: PickerReceptionist[]; labels: ReceptionistPickerLabels }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const searchField = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const searchable = choices.length >= RECEPTIONIST_PICKER_SEARCH_FROM;
  const shown = useMemo(() => {
    const term = folded(query.trim());
    return term ? choices.filter((choice) => folded(`${choice.name} ${choice.description}`).includes(term)) : choices;
  }, [choices, query]);

  // A click anywhere else closes the list.
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);

  // The search box takes the focus when there is one, else the first choice.
  useEffect(() => {
    if (!open) return;
    if (searchField.current) searchField.current.focus();
    else list.current?.querySelector<HTMLAnchorElement>("a")?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    setQuery("");
    button.current?.focus();
  }

  // The button, the search box and each link share one handler: Escape closes, the arrow keys open the list and move through it.
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const links = Array.from(list.current?.querySelectorAll<HTMLAnchorElement>("a") ?? []);
    if (!links.length) return;
    event.preventDefault();
    if (!open) {
      setOpen(true);
      return;
    }
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    const next = event.key === "ArrowDown" ? (at + 1) % links.length : at <= 0 ? links.length - 1 : at - 1;
    links[next]?.focus();
  }

  return (
    <div ref={root} className="relative flex max-w-[460px] flex-col gap-2">
      <span id={`${id}-label`} className="text-[13px] leading-[18px] font-[650] tracking-[0.06em] uppercase">{labels.label}</span>
      <button
        ref={button}
        type="button"
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        aria-labelledby={`${id}-label ${id}-name`}
        className="flex min-h-[60px] w-full cursor-pointer items-center gap-3 rounded-2xl border-2 border-[#000] bg-[#fff] px-3 py-2 text-left text-[#000]"
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={onKeyDown}
      >
        <Badge name={current.name} large />
        <span className="flex min-w-0 flex-1 flex-col">
          <span id={`${id}-name`} className="truncate text-[17px] leading-6 font-bold">{current.name}</span>
          {current.description ? <span className="truncate text-[15px] leading-5 text-[#3D3D3D]">{current.description}</span> : null}
        </span>
        <ChevronDown aria-hidden="true" className={`size-5 flex-none transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <div id={`${id}-panel`} hidden={!open} className="absolute top-full right-0 left-0 z-20 mt-2 flex max-h-[min(440px,70svh)] flex-col overflow-hidden rounded-2xl border border-[#D6D6D2] bg-[#fff] text-[#000] shadow-[0_12px_40px_rgba(0,0,0,0.18)]">
        {searchable ? (
          <label className="flex items-center gap-2 border-b border-[#D6D6D2] px-3">
            <Search aria-hidden="true" className="size-[18px] flex-none text-[#3D3D3D]" />
            <span className="sr-only">{labels.search}</span>
            <input ref={searchField} type="search" value={query} placeholder={labels.search} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} className="min-h-12 w-full min-w-0 border-0 bg-transparent text-base outline-none" />
          </label>
        ) : null}
        <ul ref={list} aria-label={labels.choose} className="flex flex-col overflow-y-auto py-1">
          {shown.map((choice) => {
            const isCurrent = choice.href === current.href;
            return (
              <li key={choice.href}>
                <a href={choice.href} aria-current={isCurrent ? "page" : undefined} onKeyDown={onKeyDown} className="flex min-h-14 items-center gap-3 px-3 py-2 text-[#000] no-underline outline-none hover:bg-[#F4F4F1] focus-visible:bg-[#F4F4F1]">
                  <Badge name={choice.name} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-base leading-[22px] font-semibold [overflow-wrap:anywhere]">{choice.name}</span>
                    {choice.description ? <span className="text-sm leading-5 text-[#3D3D3D]">{choice.description}</span> : null}
                  </span>
                  {isCurrent ? <Check aria-label={labels.current} className="size-5 flex-none" /> : null}
                </a>
              </li>
            );
          })}
        </ul>
        {shown.length ? null : <p role="status" className="px-4 py-3 text-[15px] text-[#3D3D3D]">{labels.noMatches}</p>}
      </div>
    </div>
  );
}
