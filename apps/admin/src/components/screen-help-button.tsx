"use client";

import { useRef, useState } from "react";

import { CircleQuestionMarkIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTranslation } from "react-i18next";

import { HelpPanelBody, loadHelpRegistry } from "@/components/help/help-panel";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

// A third of a large screen, two thirds of a tablet's, and all of a phone's
// but a strip at its left, so the screen stays in view beside the panel; a
// floor and a ceiling keep the lines a readable length. Widths are of the
// page, without a scrollbar's gutter, so the strip is the same everywhere.
const panelWidth = "data-[side=right]:w-[calc(100%-3.5rem)] data-[side=right]:sm:w-2/3 data-[side=right]:sm:max-w-none data-[side=right]:lg:w-1/3 data-[side=right]:lg:min-w-[28rem] data-[side=right]:lg:max-w-[40rem]";
// A light, unblurred backdrop, so the reader can match the page's steps to
// the screen beside it.
const panelOverlay = "bg-black/20 supports-backdrop-filter:backdrop-blur-none";

function prefetch() {
  void loadHelpRegistry().catch(() => undefined);
}

/**
 * The question mark at the top right of a screen, the last of the buttons
 * there. It opens the screen's help page in a panel at the right of the
 * screen, which closes with its close button, the Escape key, a click beside
 * it or a move to another screen.
 */
export function ScreenHelpButton({ className, size = "icon-xs" }: { /** Placement, for the button's wrapper. */ className?: string; size?: "icon" | "icon-sm" | "icon-xs" }) {
  const { t } = useTranslation("common");
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);
  // The screen the panel was opened on: it keeps its article while it closes.
  const [panelPath, setPanelPath] = useState(pathname);
  // Moving to another screen closes the panel.
  const [seenPath, setSeenPath] = useState(pathname);
  // The panel's title takes the focus when it opens, so the reader starts at
  // the top rather than at the first link far down the page.
  const titleRef = useRef<HTMLHeadingElement>(null);
  if (seenPath !== pathname) {
    setSeenPath(pathname);
    setOpen(false);
  }
  return (
    <Sheet onOpenChange={(next) => { if (next) setPanelPath(pathname); setOpen(next); }} open={open}>
      <Tooltip>
        <TooltipTrigger render={<span className={cn("inline-flex", className)} />}>
          <SheetTrigger
            render={
              <Button
                aria-label={t("help.screen")}
                className="text-sidebar-foreground hover:bg-transparent hover:text-sidebar-accent-foreground aria-expanded:bg-transparent"
                onFocus={prefetch}
                onPointerEnter={prefetch}
                size={size}
                type="button"
                variant="ghost"
              />
            }
          >
            <CircleQuestionMarkIcon className="size-[18px]" strokeWidth={1.75} />
          </SheetTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("help.screen")}</TooltipContent>
      </Tooltip>
      <SheetContent className={cn("gap-0 p-0", panelWidth)} initialFocus={titleRef} overlayClassName={panelOverlay} side="right">
        <HelpPanelBody pathname={panelPath} titleRef={titleRef} />
      </SheetContent>
    </Sheet>
  );
}
