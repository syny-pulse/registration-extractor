import {
  GoogleGenAI,
  HarmBlockThreshold,
  HarmCategory,
  createPartFromBase64,
  createPartFromText,
} from "@google/genai";

import { GEMINI_API_KEY, GEMINI_MODEL, MAX_COLUMNS, MAX_ROWS } from "./config";
import { extractionSchema, type Extraction } from "./validation";

/**
 * The instruction the whole product rests on.
 *
 * The hard rule is the one about guessing. A plausible-looking wrong name is
 * worse than an obvious gap: the gap gets checked against the paper, the wrong
 * name gets emailed. UNCLEAR is therefore framed as the correct answer rather
 * than a failure, which is also why the workbook renders it in bold — it is
 * meant to be seen and resolved, not skimmed past.
 */
const PROMPT = `You are transcribing a scanned paper registration or sign-in sheet.

Return the table exactly as it appears on the page.

COLUMNS
- Use the sheet's own printed column headers, in left-to-right order, as "columns".
- If a column has no printed header, name it by what it evidently holds (for example "Signature" or "Time in").
- If several pages carry the same table, use one shared set of columns for all of them.

ROWS
- One entry in "rows" per filled-in data row, in the order they appear.
- "page" is the 1-based page the row was read from.
- "values" must have exactly one entry per column, in the same order as "columns".
- Do not emit the printed header row itself as data.
- Skip rows that are entirely blank.

READING THE HANDWRITING
- Transcribe exactly what is written, including unusual spellings and capitalisation.
- Use the exact string UNCLEAR for any cell you cannot read with confidence.
- Use an empty string for a cell that is genuinely blank.
- For a signature that is a mark rather than legible text, use UNCLEAR.

NEVER GUESS. Do not complete a partial name, do not correct a spelling, do not
infer a value from another row or from context, and do not invent an entry that
is not physically on the page. If you are unsure, UNCLEAR is the correct answer.`;

/** Fixed keys are impossible here — the sheet decides its own columns. */
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    columns: {
      type: "array",
      description: "The sheet's column headers, left to right.",
      items: { type: "string" },
    },
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: {
          page: { type: "integer", description: "1-based source page." },
          values: {
            type: "array",
            description: "One value per column, in column order.",
            items: { type: "string" },
          },
        },
        required: ["page", "values"],
      },
    },
  },
  required: ["columns", "rows"],
} as const;

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (client) return client;

  if (!GEMINI_API_KEY) {
    throw new ExtractionError(
      "no_api_key",
      "The server has no Gemini API key configured. An administrator needs to set GEMINI_API_KEY.",
    );
  }

  // The Gemini Developer API, keyed by an AI Studio API key.
  //
  // The key MUST belong to a project on the paid tier. On the free tier Google
  // uses submitted content to improve its products and human reviewers may read
  // it — which would be flatly incompatible with running other people's
  // registration sheets through this. See README, "How your data is handled".
  client = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

  return client;
}

export type ExtractionResult = {
  extraction: Extraction;
  unclearCount: number;
};

/**
 * A failure we raised ourselves, carrying a fixed code and a message written
 * for the person who hit it.
 *
 * The distinction matters for logging. Arbitrary SDK errors have their message
 * discarded, because provider libraries quote request content back inside error
 * strings — that is the realistic route by which an attendee's name reaches a
 * log. These messages are written here, in this file, and contain nothing from
 * the document, so they are safe to log and to show. Without them every failure
 * reduced to the word "Error", which is privacy-preserving and useless: it
 * cannot tell a missing API key from a timeout from an exhausted quota.
 */
export type ExtractionErrorCode =
  | "no_api_key"
  | "timeout"
  | "blocked"
  | "empty_response"
  | "bad_json"
  | "bad_shape"
  | "too_large_result"
  | "api_error";

export class ExtractionError extends Error {
  constructor(
    readonly code: ExtractionErrorCode,
    /** Shown to the user. Never contains document content. */
    readonly userMessage: string,
    /** Appended to the log code only — a status or finish reason, never text. */
    readonly detail?: string,
  ) {
    super(`${code}${detail ? `:${detail}` : ""}`);
    this.name = "ExtractionError";
  }
}

/**
 * Reduces an error from the Gemini SDK to one of our codes.
 *
 * Only the HTTP status is carried across, never the message. A status is enough
 * to separate the cases an operator actually needs to act on: 401/403 means the
 * key is wrong, 429 means quota, 400 means we sent something malformed.
 */
function fromSdkError(err: unknown): ExtractionError {
  if (err instanceof ExtractionError) return err;

  // AbortSignal.timeout produces a DOMException named TimeoutError.
  const name = (err as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    return new ExtractionError(
      "timeout",
      "The document took too long to read. Try splitting it into fewer pages and uploading again.",
    );
  }

  const status = (err as { status?: unknown })?.status;

  // Reading the SDK message to *classify* is safe; the rule this file follows is
  // never to **emit** it. Everything below turns a match into one of our own
  // fixed strings, and the original text is discarded either way.
  //
  // This matters because a rejected key comes back as HTTP 400, not 401 — the
  // status alone cannot distinguish "your key is wrong", far and away the most
  // likely deployment failure, from "we sent something malformed".
  const raw = typeof (err as Error)?.message === "string" ? (err as Error).message : "";

  if (/API_KEY_INVALID|API key not valid|api key expired/i.test(raw)) {
    return new ExtractionError(
      "api_error",
      "The server's Gemini API key was rejected. An administrator needs to check GEMINI_API_KEY.",
      "invalid_key",
    );
  }

  if (/RESOURCE_EXHAUSTED|quota|rate limit/i.test(raw) || status === 429) {
    return new ExtractionError(
      "api_error",
      "The Gemini quota is exhausted. If the project is still on the free tier, it needs billing enabled.",
      "quota",
    );
  }

  if (/PERMISSION_DENIED|not enabled|has not been used/i.test(raw)) {
    return new ExtractionError(
      "api_error",
      "The Gemini API is not enabled for this key's project, or the key lacks permission.",
      "permission",
    );
  }

  if (/not found|NOT_FOUND/i.test(raw)) {
    return new ExtractionError(
      "api_error",
      `The configured model (${GEMINI_MODEL}) is not available to this key. An administrator should check GEMINI_MODEL.`,
      "model_not_found",
    );
  }

  if (typeof status === "number") {
    if (status === 401 || status === 403) {
      return new ExtractionError(
        "api_error",
        "The server's Gemini API key was rejected. An administrator needs to check GEMINI_API_KEY.",
        String(status),
      );
    }
    return new ExtractionError(
      "api_error",
      `The AI service returned an error (HTTP ${status}). Please try again.`,
      String(status),
    );
  }

  return new ExtractionError(
    "api_error",
    "The AI service could not be reached. Please try again.",
  );
}

/**
 * Sends the PDF to Gemini and returns the validated table.
 *
 * The document goes over as inline base64 in a single request — no upload to
 * the Files API, no intermediate storage, nothing to clean up afterwards. At
 * ten pages under 4 MB this is comfortably inside the inline limit.
 */
export async function extractTable(
  pdfBytes: Uint8Array,
  signal?: AbortSignal,
): Promise<ExtractionResult> {
  const ai = getClient();

  let response;
  try {
    response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            createPartFromBase64(Buffer.from(pdfBytes).toString("base64"), "application/pdf"),
            createPartFromText(PROMPT),
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseJsonSchema: RESPONSE_SCHEMA,
        // Transcription has one right answer; sampling variety is pure downside.
        temperature: 0,
        safetySettings: [
          HarmCategory.HARM_CATEGORY_HARASSMENT,
          HarmCategory.HARM_CATEGORY_HATE_SPEECH,
          HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
          HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
        ].map((category) => ({
          category,
          // A list of names has no business tripping a safety filter, and a
          // false positive does not degrade the result — it destroys it,
          // silently returning an empty response for a perfectly fine document.
          threshold: HarmBlockThreshold.BLOCK_NONE,
        })),
        abortSignal: signal,
      },
    });
  } catch (err) {
    throw fromSdkError(err);
  }

  const text = response.text;
  if (!text) {
    // Empty output with a non-STOP finish reason means the response was cut off
    // or filtered rather than completed. The reason is a fixed enum from the
    // API, not free text, so it is safe to carry into the log.
    const reason = String(response.candidates?.[0]?.finishReason ?? "empty");

    if (reason === "SAFETY" || reason === "PROHIBITED_CONTENT" || reason === "RECITATION") {
      throw new ExtractionError(
        "blocked",
        "The AI service declined to process this document. If it is an ordinary registration sheet, please report this.",
        reason,
      );
    }

    throw new ExtractionError(
      "empty_response",
      reason === "MAX_TOKENS"
        ? "This document produced more data than fits in a single response. Split it into fewer pages and try again."
        : "The AI service returned nothing for this document. Please try again.",
      reason,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ExtractionError(
      "bad_json",
      "The AI service returned a malformed response. Please try again.",
    );
  }

  const result = extractionSchema.safeParse(parsed);
  if (!result.success) {
    throw new ExtractionError(
      "bad_shape",
      "The AI service returned an unexpected response. Please try again.",
    );
  }

  return normalize(result.data);
}

/**
 * Squares up the model's output before it becomes a spreadsheet.
 *
 * A JSON schema can require an array of strings without requiring it to be the
 * right length, so row width is enforced here rather than assumed. The caps are
 * there so a runaway response becomes a clean error instead of an enormous
 * workbook built in a function's memory.
 */
export function normalize(extraction: Extraction): ExtractionResult {
  if (extraction.columns.length > MAX_COLUMNS) {
    throw new ExtractionError(
      "too_large_result",
      `This document appears to have more than ${MAX_COLUMNS} columns, which is more than can be processed.`,
      "columns",
    );
  }
  if (extraction.rows.length > MAX_ROWS) {
    throw new ExtractionError(
      "too_large_result",
      `This document produced more than ${MAX_ROWS} rows. Split it into fewer pages and try again.`,
      "rows",
    );
  }

  const width = extraction.columns.length;
  let unclearCount = 0;

  const rows = extraction.rows.map((row) => {
    const values = Array.from({ length: width }, (_, i) => {
      const value = (row.values[i] ?? "").trim();
      if (value === "UNCLEAR") unclearCount += 1;
      return value;
    });
    return { page: row.page, values };
  });

  return {
    extraction: { columns: extraction.columns.map((c) => c.trim()), rows },
    unclearCount,
  };
}
