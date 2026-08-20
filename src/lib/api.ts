import { NextResponse } from "next/server";
import { HttpError } from "./guards";
import { describeError, log } from "./log";

/**
 * Turns a thrown value into a response.
 *
 * HttpError carries a message written for the user; anything else is reduced to
 * a generic 500. That asymmetry is the point — an unexpected error's message
 * may quote request content, and this app must not hand document text back to
 * a caller or write it to a log.
 */
export function errorResponse(event: string, err: unknown, userId?: string) {
  if (err instanceof HttpError) {
    log({ event, status: "rejected", userId, reason: err.code });
    // The code goes back alongside the sentence for the same reason the
    // extraction failures carry one: it is short, fixed, drawn from our own
    // vocabulary, and makes a bug report actionable without anyone opening the
    // platform logs. It carries nothing from the document.
    return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
  }

  log({ event, status: "error", userId, reason: describeError(err) });
  return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
}
