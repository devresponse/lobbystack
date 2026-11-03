"use client";

import { FormEvent, useState } from "react";

import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { audienceErrorMessage, isAudienceError } from "@/components/knowledge-audience";
import { draftRulesForSave, ImportWebsiteRules, type DraftRule } from "@/components/knowledge-website-rules";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export type WebsiteImportRuleInput = { pathPrefix: string; receptionistId: string };

export function ImportWebsiteKnowledgeSheet({
  save,
  receptionists = [],
  open,
  onOpenChange,
}: {
  /** Starts the import; websiteRules is there only when the owner added page rules. */
  save: (websiteUrl: string, websiteRules?: WebsiteImportRuleInput[]) => Promise<void>;
  /** The business's receptionists; with several, page rules give sections of the site to one each. */
  receptionists?: ReceptionistOption[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["agent", "receptionists"]);
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [drafts, setDrafts] = useState<DraftRule[]>([]);
  const [invalidDrafts, setInvalidDrafts] = useState<string[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const several = receptionists.length > 1;

  function resetState(): void {
    setWebsiteUrl("");
    setDrafts([]);
    setInvalidDrafts([]);
    setErrorMessage(null);
    setIsSubmitting(false);
  }

  function changeDrafts(next: DraftRule[]): void {
    // A row the owner changed is checked again on the next save.
    setInvalidDrafts((current) => current.filter((key) => {
      const before = drafts.find((draft) => draft.key === key);
      const after = next.find((draft) => draft.key === key);
      return Boolean(before && after && before.path === after.path && before.receptionistId === after.receptionistId);
    }));
    setDrafts(next);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const trimmedWebsiteUrl = websiteUrl.trim();
    if (!trimmedWebsiteUrl) {
      setErrorMessage(t("sections.knowledge.websiteImport.validation.urlRequired"));
      return;
    }
    // Rules only count with several receptionists; with one, the field is hidden.
    const { rules, invalid } = several ? draftRulesForSave(drafts) : { rules: [], invalid: [] };
    setInvalidDrafts(invalid);
    if (invalid.length) {
      setErrorMessage(null);
      return;
    }

    setIsSubmitting(true);
    setErrorMessage(null);

    try {
      await (rules.length ? save(trimmedWebsiteUrl, rules) : save(trimmedWebsiteUrl));
      toast.success(t("sections.knowledge.websiteImport.success"));
      onOpenChange(false);
      resetState();
    } catch (error) {
      setErrorMessage(
        isAudienceError(error)
          ? audienceErrorMessage(error, t)
          : error instanceof Error && error.message
            ? error.message
            : t("sections.knowledge.websiteImport.submitFailed"),
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        onOpenChange(nextOpen);
        if (!nextOpen) {
          resetState();
        }
      }}
      open={open}
    >
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("sections.knowledge.websiteImport.title")}</DialogTitle>
          <DialogDescription>
            {t("sections.knowledge.websiteImport.description")}
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-6" onSubmit={(event) => void handleSubmit(event)}>
          <FieldGroup>
            <Field>
              <FieldContent>
                <FieldLabel htmlFor="knowledge-website-url">
                  {t("sections.knowledge.fields.websiteUrl.label")}
                </FieldLabel>
                <FieldDescription>
                  {t("sections.knowledge.fields.websiteUrl.hint")}
                </FieldDescription>
              </FieldContent>
              <Input
                autoComplete="url"
                id="knowledge-website-url"
                onChange={(event) => {
                  setWebsiteUrl(event.target.value);
                  if (errorMessage) {
                    setErrorMessage(null);
                  }
                }}
                placeholder={t("sections.knowledge.fields.websiteUrl.placeholder")}
                type="url"
                value={websiteUrl}
              />
            </Field>

            <ImportWebsiteRules
              disabled={isSubmitting}
              drafts={drafts}
              invalid={invalidDrafts}
              onChange={changeDrafts}
              receptionists={receptionists}
            />
          </FieldGroup>

          {errorMessage ? <FieldError>{errorMessage}</FieldError> : null}

          <DialogFooter>
            <Button className="w-full" disabled={isSubmitting} type="submit">
              {isSubmitting ? (
                <>
                  <LoaderCircle className="size-4 animate-spin" />
                  {t("sections.knowledge.websiteImport.submitting")}
                </>
              ) : (
                t("sections.knowledge.websiteImport.submit")
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
