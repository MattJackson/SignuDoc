import { type DbPool, getDb, queryOne } from "../../db/connection.ts";
import { createDraftEnvelope } from "../../envelopes.ts";
import type { StorageService } from "../../services/storage.ts";
import { recordEnvelopeSource } from "./addon/contracts.ts";
import { pdfFileName } from "./convert.ts";

// A draft envelope from a document that came from Google (Drive's Picker,
// Drive's "Open with", the Gmail and Drive add-on) instead of an upload on
// the new-envelope page.
//
// It goes through createDraftEnvelope, the same path as an upload: the
// same size limit and PDF checks (document-import.ts), the same storage
// and the same "created" audit event, which here also says where the
// document came from. The dashboard thumbnail is drawn by the sender's
// browser the first time the draft is shown, as for any draft without one.
//
// The caller has already established who the person is (a session, or the
// add-on's verified Google identity). The account is checked again here:
// only a verified account may start an envelope.

export class ImportDraftAccountError extends Error {
  constructor() {
    super("This account cannot send documents.");
    this.name = "ImportDraftAccountError";
  }
}

/** A title for the draft from the document's name. */
export function draftTitleFromFileName(fileName: string): string {
  const title = pdfFileName(fileName)
    .replace(/\.pdf$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160)
    .trim();

  return title || "Untitled document";
}

export async function createDraftFromDocument(
  input: {
    userId: string;
    bytes: Uint8Array;
    fileName: string;
    source: { kind: "drive" | "gmail" | "upload"; ref?: string };
  },
  {
    database = getDb(),
    storageService,
  }: { database?: DbPool; storageService?: StorageService } = {},
): Promise<{ envelopeId: string }> {
  const account = await queryOne<{ emailVerified: boolean }>(
    database,
    `SELECT "emailVerified" FROM public."user" WHERE id = $1`,
    [input.userId],
  );

  if (!account?.emailVerified) {
    throw new ImportDraftAccountError();
  }

  const result = await createDraftEnvelope(
    input.userId,
    {
      importSource: input.source,
      sourcePdf: {
        body: input.bytes,
        contentType: "application/pdf",
        filename: pdfFileName(input.fileName),
      },
      title: draftTitleFromFileName(input.fileName),
    },
    { database, ...(storageService ? { storageService } : {}) },
  );

  const envelopeId = result.envelope.id;

  // Where the document came from, so the add-on can list the envelopes made
  // from a file. The draft is made either way.
  if (input.source.kind !== "upload" && input.source.ref) {
    await recordEnvelopeSource(
      {
        envelopeId,
        kind: input.source.kind,
        ref: input.source.ref,
        userId: input.userId,
      },
      database,
    ).catch((error: unknown) => {
      console.warn(
        `[drive] Noting the ${input.source.kind} source of draft ${envelopeId} failed:`,
        error instanceof Error ? error.message : error,
      );
    });
  }

  return { envelopeId };
}

/** Where a new draft continues: choosing its signers. */
export function draftPreparePath(envelopeId: string): string {
  return `/envelopes/${envelopeId}/signers`;
}
