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
    throw new Error("GEMINI_API_KEY is not set.");
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

  const response = await ai.models.generateContent({
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
        // A list of names has no business tripping a safety filter, and a false
        // positive does not degrade the result — it destroys it, silently
        // returning an empty response for a document that was perfectly fine.
        threshold: HarmBlockThreshold.BLOCK_NONE,
      })),
      abortSignal: signal,
    },
  });

  const text = response.text;
  if (!text) {
    // Empty output with a non-STOP finish reason means the response was cut
    // off or filtered rather than completed.
    const reason = response.candidates?.[0]?.finishReason ?? "empty";
    throw new Error(`Model returned no content (${reason})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Model response was not valid JSON");
  }

  const result = extractionSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error("Model response did not match the expected shape");
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
    throw new Error("Model returned an implausible number of columns");
  }
  if (extraction.rows.length > MAX_ROWS) {
    throw new Error("Model returned an implausible number of rows");
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
