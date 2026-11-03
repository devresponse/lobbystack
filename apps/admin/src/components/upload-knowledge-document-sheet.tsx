"use client";

import { type DragEvent, FormEvent, useMemo, useRef, useState } from "react";

import { useTranslation } from "react-i18next";
import { Upload } from "lucide-react";

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
import { audienceErrorMessage, isAudienceError } from "@/components/knowledge-audience";
import { AudienceField, audienceChoiceOf, EVERYONE, type AudienceChoice, type AudienceValue } from "@/components/receptionists/audience-field";
import type { ReceptionistOption } from "@/components/receptionists/receptionist-choices";
import { uploadErrorMessage } from "@/lib/storage-upload";
const ACCEPTED_FILE_TYPES = ".pdf,.docx,.txt,.md,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_DOCUMENT_UPLOAD_BYTES = 10 * 1024 * 1024;

function parseTags(value: string): Array<string> {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/u, "").trim();
}

function inferContentTypeFromFileName(fileName: string): string {
  const extension = fileName.split(".").pop()?.toLowerCase();
  switch (extension) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "md":
      return "text/markdown";
    case "txt":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function isSupportedContentType(contentType: string): boolean {
  return [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
    "text/markdown",
    "text/x-markdown",
  ].includes(contentType);
}

function resolveFileContentType(file: File): string {
  const providedType = file.type.trim();
  if (providedType.length > 0) {
    return providedType;
  }

  return inferContentTypeFromFileName(file.name);
}

export type KnowledgeDocumentUploadInput = { file: File; contentType: string; title: string; tags: string[]; audience?: AudienceChoice };

export function UploadKnowledgeDocumentSheet({
  upload,
  receptionists = [],
  open,
  onOpenChange,
}: {
  /** Uploads the file; audience is there only when the owner chose receptionists for it. */
  upload: (input: KnowledgeDocumentUploadInput) => Promise<void>;
  /** The business's receptionists; with several, the file says who it's available to. */
  receptionists?: ReceptionistOption[] | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["agent", "receptionists"]);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [audienceValue, setAudienceValue] = useState<AudienceValue>(EVERYONE);
  const [audienceSubmitted, setAudienceSubmitted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resolvedFileName = useMemo(() => selectedFile?.name ?? "", [selectedFile]);
  // A file is for everyone unless the owner chose receptionists, which needs at least one.
  const sendAudience = receptionists.length > 1 && audienceValue.audience === "chosen";
  const audienceChoice = audienceChoiceOf(audienceValue, receptionists);

  function resetState(): void {
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
    setSelectedFile(null);
    setTitle("");
    setTags("");
    setAudienceValue(EVERYONE);
    setAudienceSubmitted(false);
    setErrorMessage(null);
    setIsUploading(false);
    setIsDraggingFile(false);
  }

  function handleSelectedFile(file: File | null): void {
    if (file && file.size > MAX_DOCUMENT_UPLOAD_BYTES) {
      setSelectedFile(null);
      setTitle("");
      setErrorMessage(t("sections.knowledge.uploadValidation.maxSize"));
      return;
    }

    setSelectedFile(file);
    setTitle(file ? stripExtension(file.name) : "");
    setErrorMessage(null);
  }

  function handleFileDrop(event: DragEvent<HTMLLabelElement>): void {
    event.preventDefault();
    setIsDraggingFile(false);
    handleSelectedFile(event.dataTransfer.files?.[0] ?? null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!selectedFile) {
      setErrorMessage(t("sections.knowledge.uploadValidation.fileRequired"));
      return;
    }

    const contentType = resolveFileContentType(selectedFile);
    if (!isSupportedContentType(contentType)) {
      setErrorMessage(t("sections.knowledge.uploadValidation.unsupportedFile"));
      return;
    }

    if (selectedFile.size > MAX_DOCUMENT_UPLOAD_BYTES) {
      setErrorMessage(t("sections.knowledge.uploadValidation.maxSize"));
      return;
    }

    setAudienceSubmitted(true);
    if (sendAudience && !audienceChoice) {
      setErrorMessage(null);
      return;
    }

    setIsUploading(true);
    setErrorMessage(null);
    try {
      await upload({ file: selectedFile, contentType, title: title.trim(), tags: parseTags(tags), ...(sendAudience && audienceChoice ? { audience: audienceChoice } : {}) });

      onOpenChange(false);
      resetState();
    } catch (error) {
      setErrorMessage(
        isAudienceError(error)
          ? audienceErrorMessage(error, t)
          : uploadErrorMessage(
            error,
            t("sections.knowledge.uploadValidation.uploadFailed"),
          ),
      );
    } finally {
      setIsUploading(false);
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
          <DialogTitle>{t("sections.knowledge.uploadDocument")}</DialogTitle>
          <DialogDescription>
            {t("sections.knowledge.uploadDocumentDescription")}
          </DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-6" onSubmit={(event) => void handleSubmit(event)}>
          <FieldGroup>
            <Field>
              <FieldContent>
                <FieldLabel htmlFor="knowledge-document-file">
                  {t("sections.knowledge.fields.file.label")}
                </FieldLabel>
                <FieldDescription>
                  {t("sections.knowledge.fields.file.hint")}
                </FieldDescription>
              </FieldContent>
              <Input
                accept={ACCEPTED_FILE_TYPES}
                className="sr-only"
                id="knowledge-document-file"
                onChange={(event) => {
                  handleSelectedFile(event.target.files?.[0] ?? null);
                }}
                ref={fileInputRef}
                type="file"
              />
              <label
                className={`flex min-h-32 cursor-pointer flex-col items-center justify-center rounded-xl border border-dashed px-6 py-8 text-center transition-colors ${
                  isDraggingFile
                    ? "border-foreground/30 bg-muted/40"
                    : "border-border/70 bg-muted/20 hover:bg-muted/30"
                }`}
                htmlFor="knowledge-document-file"
                onDragEnter={(event) => {
                  event.preventDefault();
                  setIsDraggingFile(true);
                }}
                onDragLeave={(event) => {
                  event.preventDefault();
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    return;
                  }
                  setIsDraggingFile(false);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setIsDraggingFile(true);
                }}
                onDrop={handleFileDrop}
              >
                <div className="flex flex-col items-center gap-3">
                  <Upload className="size-5 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {t("sections.knowledge.fields.file.dropzonePrefix")}{" "}
                    <span className="underline underline-offset-2">
                      {t("sections.knowledge.fields.file.chooseFile")}
                    </span>
                  </p>
                  {resolvedFileName ? (
                    <p className="type-item-title">{resolvedFileName}</p>
                  ) : null}
                </div>
              </label>
            </Field>

            <Field>
              <FieldContent>
                <FieldLabel htmlFor="knowledge-document-title">
                  {t("sections.knowledge.fields.title.label")}
                </FieldLabel>
                <FieldDescription>
                  {t("sections.knowledge.fields.title.hint")}
                </FieldDescription>
              </FieldContent>
              <Input
                id="knowledge-document-title"
                placeholder={t("sections.knowledge.fields.title.placeholder")}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </Field>

            <Field>
              <FieldContent>
                <FieldLabel htmlFor="knowledge-document-tags">
                  {t("sections.knowledge.fields.tags.label")}
                </FieldLabel>
                <FieldDescription>
                  {t("sections.knowledge.fields.tags.hint")}
                </FieldDescription>
              </FieldContent>
              <Input
                id="knowledge-document-tags"
                placeholder={t("sections.knowledge.fields.tags.placeholder")}
                value={tags}
                onChange={(event) => setTags(event.target.value)}
              />
            </Field>

            <AudienceField
              disabled={isUploading}
              invalid={audienceSubmitted && sendAudience && !audienceChoice}
              onChange={setAudienceValue}
              receptionists={receptionists}
              value={audienceValue}
            />
          </FieldGroup>

          {errorMessage ? <FieldError>{errorMessage}</FieldError> : null}

          <DialogFooter>
            <Button className="w-full" disabled={isUploading} type="submit">
              {isUploading ? t("actions.saving") : t("actions.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
