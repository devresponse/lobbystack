import { Fragment } from "react";

const MARKS = /(\*\*[^*]+\*\*|`[^`]+`)/g;

/** Help text as HTML: **bold** marks a label as the screen shows it, and `code` something typed or copied exactly. */
export function HelpText({ text }: { text: string }) {
  return (
    <>
      {text.split(MARKS).map((part, index) => {
        if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) return <strong className="font-semibold text-foreground" key={index}>{part.slice(2, -2)}</strong>;
        if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) return <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.875em] text-foreground" key={index}>{part.slice(1, -1)}</code>;
        return <Fragment key={index}>{part}</Fragment>;
      })}
    </>
  );
}
