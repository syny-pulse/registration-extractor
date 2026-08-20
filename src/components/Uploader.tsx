"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";

import { shrinkPhotos } from "@/lib/downscale";
import { filenameFromHeader } from "@/lib/filename";
import { UPLOAD_ACCEPT_ATTRIBUTE, inspectUpload } from "@/lib/upload";
import { Button, Card, Notice, cx } from "./ui";

type Job = {
  kind: "pdf" | "images";
  /** In page order — the order they were checked in and will be uploaded in. */
  files: File[];
  pageCount: number;
};

type Phase =
  | { kind: "idle" }
  | { kind: "preparing"; count: number }
  | { kind: "checking"; count: number }
  | { kind: "ready"; job: Job }
  | { kind: "working"; job: Job }
  | { kind: "done"; job: Job; unclear: number; fileName: string };

/** "3 photos", "1 page" — the unit follows what was actually uploaded. */
function describeJob(job: Job): string {
  const noun = job.kind === "images" ? "photo" : "page";
  return `${job.pageCount} ${job.pageCount === 1 ? noun : `${noun}s`}`;
}

function totalBytes(files: File[]): number {
  return files.reduce((sum, file) => sum + file.size, 0);
}

export function Uploader({
  credits,
  maxPages,
  maxImages,
  maxUploadBytes,
}: {
  credits: number;
  maxPages: number;
  maxImages: number;
  maxUploadBytes: number;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [remaining, setRemaining] = useState(credits);

  const accept = useCallback(
    async (files: File[]) => {
      setError(null);
      setErrorCode(null);

      // Photos are shrunk before anything else looks at them, because otherwise
      // the size check would refuse a perfectly ordinary set of phone photos on
      // a limit the user cannot see and has no obvious way to meet. A selection
      // already over the photo limit skips this — there is no sense spending
      // seconds re-encoding files that are about to be refused on their count.
      let prepared = files;
      if (files.length <= maxImages) {
        setPhase({ kind: "preparing", count: files.length });
        prepared = await shrinkPhotos(files, maxUploadBytes);
      }

      setPhase({ kind: "checking", count: prepared.length });

      // Checking here means an 11-page document, an 11-photo set or a .docx is
      // refused in a moment rather than after a slow upload that was never
      // going to be accepted. The server repeats every one of these checks.
      const inspection = await inspectUpload(prepared, {
        maxPages,
        maxImages,
        maxBytes: maxUploadBytes,
      });

      if (!inspection.ok) {
        setError(inspection.message);
        setErrorCode(inspection.code);
        setPhase({ kind: "idle" });
        return;
      }

      setPhase({
        kind: "ready",
        job: {
          kind: inspection.kind,
          files: inspection.files,
          pageCount: inspection.pageCount,
        },
      });
    },
    [maxPages, maxImages, maxUploadBytes],
  );

  async function run() {
    if (phase.kind !== "ready") return;
    const { job } = phase;

    setError(null);
    setErrorCode(null);
    setPhase({ kind: "working", job });

    // One field name, repeated. The server reads them back with getAll, so a
    // single PDF and a set of photos travel over the same shape of request.
    const body = new FormData();
    for (const file of job.files) body.append("file", file);

    let response: Response;
    try {
      response = await fetch("/api/extract", { method: "POST", body });
    } catch {
      setError("The upload did not complete. Check your connection and try again.");
      setErrorCode("network");
      setPhase({ kind: "ready", job });
      return;
    }

    if (!response.ok) {
      const detail = await response.json().catch(() => null);

      if (detail?.error) {
        setError(detail.error);
        // A short, fixed code alongside the sentence. It is what makes a report
        // actionable without anyone having to open the platform logs, and it
        // carries nothing from the document.
        setErrorCode(typeof detail.code === "string" ? detail.code : null);
      } else {
        // No JSON body at all means the failure happened before our handler
        // could answer — the platform rejected or killed the request.
        setError(
          response.status === 413
            ? "The upload is too large. Re-scan at 200 DPI in grayscale, or send the photos in smaller batches."
            : "The server did not respond properly. Please try again.",
        );
        setErrorCode(`http_${response.status}`);
      }

      setPhase({ kind: "ready", job });
      return;
    }

    const blob = await response.blob();
    const unclear = Number(response.headers.get("X-Unclear-Count") ?? 0);
    const creditsLeft = Number(response.headers.get("X-Credits-Remaining") ?? remaining - 1);

    // The workbook is named after the PDF, or — for photos — after the event and
    // date the model read off the sheet. Only the response knows which, so the
    // name is read back out of the header rather than guessed here.
    const fileName =
      filenameFromHeader(response.headers.get("Content-Disposition")) ?? "registrations.xlsx";

    // Hand the file to the browser and immediately drop our reference to it.
    // After the revoke below, this tab holds no copy of the extracted data.
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);

    setRemaining(creditsLeft);
    setPhase({ kind: "done", job, unclear, fileName });
    router.refresh();
  }

  function reset() {
    setPhase({ kind: "idle" });
    setError(null);
    setErrorCode(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length > 0) void accept(files);
  }

  const outOfCredits = remaining < 1;
  const busy =
    phase.kind === "working" || phase.kind === "checking" || phase.kind === "preparing";

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-4">
        <p className="text-sm text-muted">
          Credits remaining:{" "}
          <span className="font-semibold text-ink tabular-nums">{remaining}</span>
        </p>
        <p className="text-xs text-muted">
          One PDF up to {maxPages} pages, or up to {maxImages} photos ·{" "}
          {(maxUploadBytes / 1_000_000).toFixed(0)} MB total
        </p>
      </div>

      {outOfCredits && (
        <Notice tone="error">
          You have no extraction credits left. Ask an administrator to top up your account.
        </Notice>
      )}

      {phase.kind === "done" ? (
        <Card className="p-8 text-center">
          <p className="text-sm font-semibold break-all">Downloaded {phase.fileName}</p>
          <p className="mt-2 text-sm text-muted">
            {describeJob(phase.job)} processed
            {phase.unclear > 0 ? (
              <>
                {" · "}
                <span className="font-semibold text-ink tabular-nums">{phase.unclear}</span>{" "}
                {phase.unclear === 1 ? "cell" : "cells"} marked UNCLEAR
              </>
            ) : (
              " · every cell read confidently"
            )}
          </p>
          {phase.unclear > 0 && (
            <p className="mx-auto mt-3 max-w-md text-xs text-muted">
              UNCLEAR cells are shown in bold in the spreadsheet. Check them against the
              original sheet using the Page column — they were not guessed.
            </p>
          )}
          <p className="mt-6 text-xs text-muted">The file is in your downloads folder.</p>
          <Button variant="secondary" className="mt-6" onClick={reset}>
            Extract another
          </Button>
        </Card>
      ) : (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            if (!busy && !outOfCredits) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={cx(
            "border border-dashed p-10 text-center transition-colors",
            dragging ? "border-ink bg-wash" : "border-rule-strong",
            (busy || outOfCredits) && "opacity-60",
          )}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={UPLOAD_ACCEPT_ATTRIBUTE}
            className="sr-only"
            id="sheet-input"
            disabled={busy || outOfCredits}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) void accept(files);
            }}
          />

          {phase.kind === "idle" && (
            <>
              <p className="text-sm">Drop a scanned sheet or photos of the sheets here</p>
              <p className="mt-1 mb-6 text-xs text-muted">or</p>
              <Button
                variant="secondary"
                disabled={outOfCredits}
                onClick={() => inputRef.current?.click()}
              >
                Choose files
              </Button>
              <p className="mt-6 text-xs text-muted">
                A PDF, or photos of each sheet — JPEG, PNG, WebP or HEIC.
                <br />
                Photos are resized in your browser before they are sent.
              </p>
            </>
          )}

          {phase.kind === "preparing" && (
            <p className="text-sm text-muted">
              Preparing {phase.count === 1 ? "your file" : `${phase.count} files`}…
            </p>
          )}

          {phase.kind === "checking" && (
            <p className="text-sm text-muted">
              Checking {phase.count === 1 ? "your file" : `${phase.count} files`}…
            </p>
          )}

          {phase.kind === "ready" && (
            <>
              {phase.job.kind === "pdf" ? (
                <p className="text-sm font-medium break-all">{phase.job.files[0].name}</p>
              ) : (
                <>
                  <p className="text-sm font-medium">{describeJob(phase.job)}, in this order</p>
                  {/* Numbered, because this is the page order the workbook's
                      Page column will refer back to. Photos are read in name
                      order, which is not always the order they were picked. */}
                  <ol className="mx-auto mt-4 max-w-xs space-y-1 text-left text-xs text-muted">
                    {phase.job.files.map((file, index) => (
                      <li key={`${file.name}-${index}`} className="flex gap-2">
                        <span className="tabular-nums">{index + 1}.</span>
                        <span className="truncate">{file.name}</span>
                      </li>
                    ))}
                  </ol>
                </>
              )}
              <p className="mt-3 text-xs text-muted tabular-nums">
                {phase.job.kind === "pdf" ? `${describeJob(phase.job)} · ` : ""}
                {(totalBytes(phase.job.files) / 1_000_000).toFixed(1)} MB · costs 1 credit
              </p>
              <div className="mt-6 flex items-center justify-center gap-3">
                <Button onClick={run} disabled={outOfCredits}>
                  Extract names
                </Button>
                <Button variant="quiet" onClick={reset}>
                  Choose different files
                </Button>
              </div>
            </>
          )}

          {phase.kind === "working" && (
            <>
              <p className="text-sm">
                Reading {phase.job.pageCount === 1 ? "the page" : "the pages"}…
              </p>
              <div
                className="mx-auto mt-6 h-px w-56 overflow-hidden bg-rule"
                role="progressbar"
                aria-label="Extracting"
              >
                <div className="progress-sweep h-px w-1/4 bg-ink" />
              </div>
              <p className="mt-6 text-xs text-muted">
                Handwriting takes a moment. This usually finishes within a minute.
              </p>
            </>
          )}
        </div>
      )}

      {error && (
        <Notice tone="error">
          {error}
          {errorCode && (
            <span className="mt-1 block font-mono text-xs font-normal text-muted">
              {errorCode}
            </span>
          )}
        </Notice>
      )}
    </div>
  );
}
