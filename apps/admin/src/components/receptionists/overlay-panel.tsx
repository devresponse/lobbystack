"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";

// A dialog keeps its dropdowns' lists inside it, where it handles their focus and clicks.
const DIALOG = "[role=\"dialog\"], [role=\"alertdialog\"]";
// Space between the button and the list, and the least space the list keeps from the window's edges.
const GAP = 4;
const MARGIN = 8;
// With less room than this under the button and more above it, the list opens upward.
const ROOM_BELOW = 240;
const MIN_HEIGHT = 120;

type Placement = { top?: number; bottom?: number; left: number; minWidth: number; maxHeight: number };

/**
 * A dropdown's open list drawn over the page, in a portal placed against its
 * button, so a card or table that clips or scrolls neither cuts the list off
 * nor shifts under it. In a dialog the list stays under the button, inside
 * the dialog. Call prepare() as the list opens, and close on a click or focus
 * outside what contains() names: the dropdown and its list.
 */
export function useOverlayPanel({ open, root, anchor, align = "start", maxHeight }: { open: boolean; root: RefObject<HTMLElement | null>; anchor: RefObject<HTMLElement | null>; align?: "start" | "end"; maxHeight: number }) {
  const panel = useRef<HTMLDivElement>(null);
  const [overlay, setOverlay] = useState(true);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const prepare = useCallback(() => setOverlay(!root.current?.closest(DIALOG)), [root]);

  const place = useCallback(() => {
    const button = anchor.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewportHeight = window.innerHeight;
    const below = viewportHeight - rect.bottom - GAP - MARGIN;
    const above = rect.top - GAP - MARGIN;
    const upward = below < ROOM_BELOW && above > below;
    // The list is as wide as its longest line, and at least as wide as the button.
    const width = Math.max(panel.current?.offsetWidth ?? 0, rect.width);
    const left = Math.max(MARGIN, Math.min(align === "end" ? rect.right - width : rect.left, viewportWidth - width - MARGIN));
    const height = Math.max(MIN_HEIGHT, Math.min(maxHeight, Math.round(viewportHeight * 0.7), upward ? above : below));
    setPlacement({ ...(upward ? { bottom: viewportHeight - rect.top + GAP } : { top: rect.bottom + GAP }), left, minWidth: rect.width, maxHeight: height });
  }, [align, anchor, maxHeight]);

  // Placed before the browser paints it, so it never shows at the wrong spot.
  useLayoutEffect(() => {
    if (!open) setPlacement(null);
    else if (overlay) place();
  }, [open, overlay, place]);

  useEffect(() => {
    if (!open || !overlay) return;
    // Scrolling the page or a card moves the button; scrolling the list itself doesn't.
    const onScroll = (event: Event) => {
      if (!panel.current?.contains(event.target as Node)) place();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", place);
    };
  }, [open, overlay, place]);

  const contains = useCallback((node: Node | null) => Boolean(node && (root.current?.contains(node) || panel.current?.contains(node))), [root]);

  /** The open list: `className` styles it everywhere, `inlineClassName` places it under the button in a dialog. */
  function render(className: string, inlineClassName: string, children: ReactNode) {
    if (!overlay) return <div ref={panel} className={cn(className, inlineClassName)}>{children}</div>;
    const style: CSSProperties = placement
      ? { top: placement.top, bottom: placement.bottom, left: placement.left, minWidth: placement.minWidth, maxHeight: placement.maxHeight }
      : { top: 0, left: 0, visibility: "hidden" };
    return createPortal(<div ref={panel} className={cn(className, "fixed z-50")} style={style}>{children}</div>, document.body);
  }

  return { prepare, contains, render, overlay };
}
