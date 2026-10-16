"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

// The profile page's only interactive parts besides the chat. The page renders
// on the server with no translation code in the browser, so their words come in
// as props.

const COPIED_MS = 2_000;

/** Copies text, falling back to a selection where the clipboard isn't available, such as an http page. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    document.body.append(field);
    field.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      field.remove();
    }
  }
}

function useCopiedFlag(): [boolean, () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [copied, () => {
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  }];
}

/** Opens the device's share sheet for the page, or copies its link where there is none. */
export function ShareButton({ url, title, label, copiedLabel, className, children }: { url: string; title: string; label: string; copiedLabel: string; className?: string; children?: ReactNode }) {
  const [copied, markCopied] = useCopiedFlag();
  async function share() {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title, url });
        return;
      } catch (error) {
        // The visitor closed the share sheet.
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    if (await copyText(url)) markCopied();
  }
  return (
    <button type="button" className={className} onClick={() => void share()}>
      {children}
      {label}
      <span role="status" className="sr-only">{copied ? copiedLabel : ""}</span>
      {copied ? <span aria-hidden="true" className="font-medium no-underline">· {copiedLabel}</span> : null}
    </button>
  );
}

/** A square button that copies text, such as the address, and says so. */
export function CopyButton({ text, label, copiedLabel, className }: { text: string; label: string; copiedLabel: string; className?: string }) {
  const [copied, markCopied] = useCopiedFlag();
  const Icon = copied ? Check : Copy;
  return (
    <>
      <button type="button" aria-label={label} title={copied ? copiedLabel : label} className={className} onClick={() => void copyText(text).then((done) => { if (done) markCopied(); })}>
        <Icon aria-hidden="true" className="size-[18px]" />
      </button>
      <span role="status" className="sr-only">{copied ? copiedLabel : ""}</span>
    </>
  );
}
