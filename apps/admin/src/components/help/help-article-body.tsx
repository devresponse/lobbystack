import type { HelpWords } from "@/lib/help/registry";
import type { HelpArticle, HelpRequirement } from "@/lib/help/types";
import { cn } from "@/lib/utils";

import { HelpText } from "./help-text";

const requirementClass: Record<HelpRequirement, string> = {
  required: "bg-foreground text-background",
  optional: "bg-muted text-muted-foreground",
  conditional: "border border-border text-foreground",
};

/**
 * Where the article is shown: on its own help page, under the page's title,
 * or in the help panel beside a screen, under the panel's title. The panel is
 * narrower and its headings one level lower.
 */
export type HelpArticleVariant = "page" | "panel";

function PartHeading({ children, className, id, variant }: { children: React.ReactNode; className?: string; id?: string; variant: HelpArticleVariant }) {
  const Tag = variant === "page" ? "h2" : "h3";
  return <Tag className={cn("font-heading font-semibold tracking-tight text-foreground", variant === "page" ? "text-xl" : "text-lg", className)} id={id}>{children}</Tag>;
}

function SubHeading({ children, variant }: { children: React.ReactNode; variant: HelpArticleVariant }) {
  const Tag = variant === "page" ? "h3" : "h4";
  return <Tag className="font-heading text-base font-semibold text-foreground">{children}</Tag>;
}

function Part({ children, id, title, variant }: { children: React.ReactNode; id: string; title: string; variant: HelpArticleVariant }) {
  return (
    <section aria-labelledby={id} className={variant === "page" ? "mt-12" : "mt-10"}>
      <PartHeading id={id} variant={variant}>{title}</PartHeading>
      <div className="mt-4">{children}</div>
    </section>
  );
}

// Name beside description once there is room for both, whatever the screen's width.
const pairRow = "grid gap-1 p-4 @lg/help:grid-cols-[minmax(0,11rem)_1fr] @lg/help:gap-4";

/**
 * An article's facts and parts, in the same order on every page: what the
 * screen is for, what it shows, its fields, how to do the common jobs, good to
 * know, troubleshooting, then related help when the caller passes it.
 */
export function HelpArticleBody({ article, related, variant, words }: { article: HelpArticle; related?: React.ReactNode; variant: HelpArticleVariant; words: HelpWords }) {
  const id = (part: string) => (variant === "page" ? part : `help-panel-${part}`);
  return (
    <div className="@container/help">
      <dl className="mt-8 grid gap-x-4 gap-y-2 rounded-xl border border-border bg-muted/40 p-5 text-sm leading-6 @lg/help:grid-cols-[minmax(0,11rem)_1fr] @lg/help:gap-y-4">
        <dt className="font-medium text-foreground">{words.facts.location}</dt>
        <dd className="mb-2 @lg/help:mb-0">{article.location.join(" > ")}</dd>
        <dt className="font-medium text-foreground">{words.facts.access}</dt>
        <dd className={cn(variant === "page" && "mb-2 @lg/help:mb-0")}><HelpText text={article.access} /></dd>
        {variant === "page" ? (
          <>
            <dt className="font-medium text-foreground">{words.facts.address}</dt>
            <dd className="flex flex-wrap gap-2">{article.screenPaths.map((path) => <code className="rounded-md bg-background px-1.5 py-0.5 font-mono text-[0.875em] text-foreground" key={path}>{path}</code>)}</dd>
          </>
        ) : null}
      </dl>

      <Part id={id("purpose")} title={words.headings.purpose} variant={variant}>
        <div className="flex flex-col gap-4">{article.purpose.map((paragraph, index) => <p key={index}><HelpText text={paragraph} /></p>)}</div>
      </Part>

      {article.areas?.length ? (
        <Part id={id("areas")} title={words.headings.areas} variant={variant}>
          <dl className="divide-y divide-border rounded-xl border border-border">
            {article.areas.map((area, index) => (
              <div className={pairRow} key={`${area.name}-${index}`}>
                <dt className="font-medium text-foreground">{area.name}</dt>
                <dd><HelpText text={area.description} /></dd>
              </div>
            ))}
          </dl>
        </Part>
      ) : null}

      {article.fields?.length ? (
        <Part id={id("fields")} title={words.headings.fields} variant={variant}>
          <div className="flex flex-col gap-8">
            {article.fields.map((group, groupIndex) => (
              <div key={`${group.title}-${groupIndex}`}>
                <SubHeading variant={variant}>{group.title}</SubHeading>
                {group.description ? <p className="mt-1"><HelpText text={group.description} /></p> : null}
                <dl className="mt-3 divide-y divide-border rounded-xl border border-border">
                  {group.fields.map((field, index) => (
                    <div className={pairRow} key={`${field.name}-${index}`}>
                      <dt className="flex flex-col items-start gap-1.5 font-medium text-foreground">
                        <span>{field.name}</span>
                        {field.requirement ? <span className={cn("inline-flex h-5 items-center rounded-full px-2 text-xs font-medium", requirementClass[field.requirement])}>{words.requirements[field.requirement]}</span> : null}
                      </dt>
                      <dd><HelpText text={field.description} /></dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        </Part>
      ) : null}

      {article.tasks?.length ? (
        <Part id={id("tasks")} title={words.headings.tasks} variant={variant}>
          <div className="flex flex-col gap-8">
            {article.tasks.map((task, taskIndex) => (
              <div key={`${task.title}-${taskIndex}`}>
                <SubHeading variant={variant}>{task.title}</SubHeading>
                <ol className="mt-3 flex list-decimal flex-col gap-2 pl-6 marker:text-foreground">
                  {task.steps.map((step, index) => <li className="pl-1" key={index}><HelpText text={step} /></li>)}
                </ol>
              </div>
            ))}
          </div>
        </Part>
      ) : null}

      {article.notes?.length ? (
        <Part id={id("notes")} title={words.headings.notes} variant={variant}>
          <ul className="flex list-disc flex-col gap-2 pl-6 marker:text-foreground">
            {article.notes.map((note, index) => <li className="pl-1" key={index}><HelpText text={note} /></li>)}
          </ul>
        </Part>
      ) : null}

      {article.troubleshooting?.length ? (
        <Part id={id("troubleshooting")} title={words.headings.troubleshooting} variant={variant}>
          <div className="flex flex-col gap-6">
            {article.troubleshooting.map((entry, index) => (
              <div key={`${entry.question}-${index}`}>
                <SubHeading variant={variant}><HelpText text={entry.question} /></SubHeading>
                <p className="mt-1"><HelpText text={entry.answer} /></p>
              </div>
            ))}
          </div>
        </Part>
      ) : null}

      {related ? <Part id={id("related")} title={words.headings.related} variant={variant}>{related}</Part> : null}
    </div>
  );
}
