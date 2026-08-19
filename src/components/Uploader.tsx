"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";
import { useRouter } from "next/navigation";

import { inspectPdf, looksLikePdf } from "@/lib/pdf";
import { Button, Card, Notice, cx } from "./ui";

type Phase =
  | { kind: "idle" }
  | { kind: "checking"; name: string }
  | { kind: "ready"; file: File; pageCount: number }
  | { kind: "working"; name: string; pageCount: number }
  | { kind: "done"; pageCount: number; unclear: number };

export function Uploader({
  credits,
  maxPages,
  maxUploadBytes,
}: {
  credits: number;
  maxPages: number;
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
    async (file: File) => {
      setError(null);
      setErrorCode(null);
      setPhase({ kind: "checking", name: file.name });

      if (!looksLikePdf(file)) {
        setError("Only PDF files can be processed.");
        setPhase({ kind: "idle" });
        return;
      }

      // Counting pages here means an 11-page document is refused in a moment
      // rather than after a slow upload that was never going to be accepted.
      // The server repeats every one of these checks regardless.
      const inspection = await inspectPdf(await file.arrayBuffer(), {
        maxPages,
        maxBytes: maxUploadBytes,
      });

      if (!inspection.ok) {
        setError(inspection.message);
        setErrorCode(inspection.code);
        setPhase({ kind: "idle" });
        return;
      }

      setPhase({ kind: "ready", file, pageCount: inspection.pageCount });
    },
    [maxPages, maxUploadBytes],
  );

  async function run() {
    if (phase.kind !== "ready") return;
    const { file, pageCount } = phase;

    setError(null);
    setErrorCode(null);
    setPhase({ kind: "working", name: file.name, pageCount });

    const body = new FormData();
    body.append("file", file);

    let response: Response;
    try {
      response = await fetch("/api/extract", { method: "POST", body });
    } catch {
      setError("The upload did not complete. Check your connection and try again.");
      setErrorCode("network");
      setPhase({ kind: "ready", file, pageCount });
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
            ? "The file is too large to upload. Re-scan at 200 DPI in grayscale."
            : "The server did not respond properly. Please try again.",
        );
        setErrorCode(`http_${response.status}`);
      }

      setPhase({ kind: "ready", file, pageCount });
      return;
    }

    const blob = await response.blob();
    const unclear = Number(response.headers.get("X-Unclear-Count") ?? 0);
    const creditsLeft = Number(response.headers.get("X-Credits-Remaining") ?? remaining - 1);

    // Hand the file to the browser and immediately drop our reference to it.
    // After the revoke below, this tab holds no copy of the extracted data.
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "registrations.xlsx";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);

    setRemaining(creditsLeft);
    setPhase({ kind: "done", pageCount, unclear });
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
    const file = event.dataTransfer.files?.[0];
    if (file) void accept(file);
  }

  const outOfCredits = remaining < 1;
  const busy = phase.kind === "working" || phase.kind === "checking";

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <p className="text-sm text-muted">
          Credits remaining:{" "}
          <span className="font-semibold text-ink tabular-nums">{remaining}</span>
        </p>
        <p className="text-xs text-muted">
          PDF · up to {maxPages} pages · {(maxUploadBytes / 1_000_000).toFixed(0)} MB
        </p>
      </div>

      {outOfCredits && (
        <Notice tone="error">
          You have no extraction credits left. Ask an administrator to top up your account.
        </Notice>
      )}

      {phase.kind === "done" ? (
        <Card className="p-8 text-center">
          <p className="text-sm font-semibold">Downloaded registrations.xlsx</p>
          <p className="mt-2 text-sm text-muted">
            {phase.pageCount} {phase.pageCount === 1 ? "page" : "pages"} processed
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
          <p className="mt-6 text-xs text-muted">
            The file is in your downloads folder. 
          </p>
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
            accept="application/pdf,.pdf"
            className="sr-only"
            id="pdf-input"
            disabled={busy || outOfCredits}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void accept(file);
            }}
          />

          {phase.kind === "idle" && (
            <>
              <p className="text-sm">Drop a scanned registration sheet here</p>
              <p className="mt-1 mb-6 text-xs text-muted">or</p>
              <Button
                variant="secondary"
                disabled={outOfCredits}
                onClick={() => inputRef.current?.click()}
              >
                Choose a PDF
              </Button>
            </>
          )}

          {phase.kind === "checking" && (
            <p className="text-sm text-muted">Checking {phase.name}…</p>
          )}

          {phase.kind === "ready" && (
            <>
              <p className="text-sm font-medium">{phase.file.name}</p>
              <p className="mt-1 text-xs text-muted tabular-nums">
                {phase.pageCount} {phase.pageCount === 1 ? "page" : "pages"} ·{" "}
                {(phase.file.size / 1_000_000).toFixed(1)} MB · costs 1 credit
              </p>
              <div className="mt-6 flex items-center justify-center gap-3">
                <Button onClick={run} disabled={outOfCredits}>
                  Extract names
                </Button>
                <Button variant="quiet" onClick={reset}>
                  Choose a different file
                </Button>
              </div>
            </>
          )}

          {phase.kind === "working" && (
            <>
              <p className="text-sm">Reading {phase.pageCount === 1 ? "the page" : "the pages"}…</p>
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
