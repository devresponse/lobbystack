"use client";

import { FormEvent, useEffect, useId, useRef, useState } from "react";

import { useTranslation } from "react-i18next";

import { audienceErrorMessage } from "@/components/knowledge-audience";
import { AudienceField, audienceChoiceOf, EVERYONE, type AudienceChoice, type AudienceValue } from "@/components/receptionists/audience-field";
import type { ReceptionistOption } from "@/components/receptionists/receptionist-choices";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

function parseTags(value: string): Array<string> {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function formatTags(tags: Array<string> | undefined): string {
  return (tags ?? []).join(", ");
}

export type KnowledgeSnippetInput = { title: string; content: string; tags: string[]; priority: number; active: boolean; audience?: AudienceChoice };

export function AddKnowledgeSheet({
  save,
  mode = "create",
  snippet,
  audience,
  receptionists = [],
  open,
  onOpenChange,
}: {
  /** Saves the entry; audience is there only when the owner chose who a new entry is for, or changed it. */
  save: (input: KnowledgeSnippetInput) => Promise<void>;
  mode?: "create" | "edit";
  snippet?: { title: string; content: string; tags?: string[]; priority: number; active: boolean } | null;
  /** Who the entry being edited is for, as the dialog opens on it. */
  audience?: AudienceValue | undefined;
  /** The business's receptionists; with several, the entry says who it's available to. */
  receptionists?: ReceptionistOption[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["agent", "knowledge", "receptionists"]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [audienceValue, setAudienceValue] = useState<AudienceValue>(EVERYONE);
  const [audienceTouched, setAudienceTouched] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const titleMissing = submitted && !title.trim();
  const contentMissing = submitted && !content.trim();
  // A new entry sends who it's for when the owner chose receptionists, and an
  // edited one only when the owner changed it, so saving the text alone never
  // touches who the entry is for.
  const several = receptionists.length > 1;
  const audienceChoice = audienceChoiceOf(audienceValue, receptionists);
  const sendAudience = several && (mode === "edit" ? audienceTouched : audienceValue.audience === "chosen");
  const audienceInvalid = submitted && sendAudience && !audienceChoice;
  // Who the entry is for as the dialog opens; refetches meanwhile don't undo the owner's choice.
  const openingAudience = useRef(audience);
  useEffect(() => {
    openingAudience.current = audience;
  });
  const titleId = useId();
  const contentId = useId();
  const tagsId = useId();
  const dialogTitle =
    mode === "edit"
      ? t("agent:sections.knowledge.editKnowledge")
      : t("agent:sections.knowledge.addKnowledge");
  const dialogDescription =
    mode === "edit"
      ? t("agent:sections.knowledge.editKnowledgeDescription")
      : t("agent:sections.knowledge.addKnowledgeDescription");
  const submitLabel = mode === "edit" ? t("agent:actions.saveChanges") : t("agent:actions.save");
  useEffect(() => {
    setSubmitted(false);
    setSaveError(null);
    setAudienceTouched(false);
    if (!open) {
      setTitle("");
      setContent("");
      setTags("");
      setAudienceValue(EVERYONE);
      setIsSaving(false);
      return;
    }

    setTitle(snippet?.title ?? "");
    setContent(snippet?.content ?? "");
    setTags(formatTags(snippet?.tags));
    setAudienceValue(openingAudience.current ?? EVERYONE);
  }, [open, snippet]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setSubmitted(true);
    setSaveError(null);
    const trimmedTitle = title.trim();
    const trimmedContent = content.trim();
    if (trimmedTitle.length === 0 || trimmedContent.length === 0 || (sendAudience && !audienceChoice)) {
      return;
    }
    setIsSaving(true);
    try {
      await save({
        title: trimmedTitle,
        content: trimmedContent,
        tags: parseTags(tags),
        priority: snippet?.priority ?? 75,
        active: snippet?.active ?? true,
        ...(sendAudience && audienceChoice ? { audience: audienceChoice } : {}),
      });
      onOpenChange(false);
    } catch (error) {
      // The dialog stays open with what was typed, and says what went wrong.
      setSaveError(audienceErrorMessage(error, t));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
        </DialogHeader>
        <form className="flex min-h-0 flex-col gap-6" noValidate onSubmit={(event) => void handleSubmit(event)}>
          {/* The fields scroll and the footer stays put, so a long paste never
              pushes the save button off screen. The inset keeps focus rings
              clear of the scroll edge. */}
          <div className="-m-1 min-h-0 overflow-y-auto p-1">
            <FieldGroup>
              <Field data-invalid={titleMissing || undefined}>
                <FieldContent>
                  <FieldLabel htmlFor={titleId}>
                    {t("agent:sections.knowledge.fields.title.label")}
                  </FieldLabel>
                  <FieldDescription>
                    {t("agent:sections.knowledge.fields.title.hint")}
                  </FieldDescription>
                </FieldContent>
                <Input
                  aria-describedby={titleMissing ? `${titleId}-error` : undefined}
                  aria-invalid={titleMissing || undefined}
                  id={titleId}
                  placeholder={t("agent:sections.knowledge.fields.title.placeholder")}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
                {titleMissing ? <FieldError id={`${titleId}-error`}>{t("agent:sections.knowledge.fields.title.required")}</FieldError> : null}
              </Field>

              <Field data-invalid={contentMissing || undefined}>
                <FieldContent>
                  <FieldLabel htmlFor={contentId}>
                    {t("agent:sections.knowledge.fields.content.label")}
                  </FieldLabel>
                  <FieldDescription>
                    {t("agent:sections.knowledge.fields.content.hint")}
                  </FieldDescription>
                </FieldContent>
                <Textarea
                  aria-describedby={contentMissing ? `${contentId}-error` : undefined}
                  aria-invalid={contentMissing || undefined}
                  className="max-h-[40svh] min-h-40 overflow-y-auto"
                  id={contentId}
                  placeholder={t("agent:sections.knowledge.fields.content.placeholder")}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                />
                {contentMissing ? <FieldError id={`${contentId}-error`}>{t("agent:sections.knowledge.fields.content.required")}</FieldError> : null}
              </Field>

              <Field>
                <FieldContent>
                  <FieldLabel htmlFor={tagsId}>
                    {t("agent:sections.knowledge.fields.tags.label")}
                  </FieldLabel>
                  <FieldDescription>
                    {t("agent:sections.knowledge.fields.tags.hint")}
                  </FieldDescription>
                </FieldContent>
                <Input
                  id={tagsId}
                  placeholder={t("agent:sections.knowledge.fields.tags.placeholder")}
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                />
              </Field>

              <AudienceField
                disabled={isSaving}
                invalid={audienceInvalid}
                onChange={(next) => {
                  setAudienceValue(next);
                  setAudienceTouched(true);
                }}
                receptionists={receptionists}
                value={audienceValue}
              />
            </FieldGroup>
          </div>

          {saveError ? <FieldError>{saveError}</FieldError> : null}

          <DialogFooter>
            <Button className="w-full" disabled={isSaving} type="submit">
              {isSaving ? t("agent:actions.saving") : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
