// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SiteHeader } from "./site-header";

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));

describe("SiteHeader", () => {
  it("updates its fixed styling from the dashboard scroll container", () => {
    const scrollContainerRef = createRef<HTMLElement>();

    render(
      <main ref={scrollContainerRef}>
        <SiteHeader fixed scrollContainerRef={scrollContainerRef} />
      </main>,
    );

    const header = screen.getByRole("banner");
    expect(header.className).toContain("shadow-none");

    if (!scrollContainerRef.current) {
      throw new Error("Expected the scroll container to be mounted.");
    }
    scrollContainerRef.current.scrollTop = 24;
    fireEvent.scroll(scrollContainerRef.current);

    expect(header.className).toContain("shadow");
    expect(header.className).not.toContain("shadow-none");
    expect(header.firstElementChild?.className).toContain("after:backdrop-blur-lg");
  });

  it("keeps the phone row 48px tall, even on pages long enough to scroll", () => {
    render(<SiteHeader fixed />);

    // The dashboard's scrolling column is a flex column: without shrink-0 a long page squeezes the row to the button's height.
    expect(screen.getByRole("banner").className.split(" ")).toEqual(expect.arrayContaining(["h-12", "shrink-0", "md:hidden"]));
  });
});

afterEach(cleanup);
