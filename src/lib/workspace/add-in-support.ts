import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryOne,
} from "../db/connection.ts";
import {
  buildCreateEnvelopeResponse,
  createDraftEnvelope,
  EnvelopeMutationError,
  replaceDraftEnvelopeSigners,
} from "../envelopes.ts";
import {
  ReminderMutationError,
  sendManualEnvelopeNudge,
} from "../reminders.ts";
import { consumeRateLimit } from "../security/rate-limit.ts";
import { DocumentImportError } from "../services/document-import.ts";
import type { StorageService } from "../services/storage.ts";
import { resolveAuthUrl, type EnvSource } from "../utils/env.ts";
import {
  recordEnvelopeSource,
  type EnvelopeSource,
} from "./add-in-envelopes.ts";
import { FileImportError } from "./types.ts";

// What a workspace add-in (types.ts, WorkspaceAddIn) needs from the app,
// with no provider in it, so an Outlook add-in would use the same pieces as
// the Google Workspace add-on:
//
// - where the provider calls it: one route, /api/workspace/add-in/<action>;
// - who is using it: the account with the address the provider vouches
//   for, once the provider has verified its token. Someone with no account
//   yet is asked to sign in to the site once, which makes it under the
//   sign-up rule as usual; an add-in never creates accounts;
// - a draft made from the document, the same way as an upload
//   (createDraftEnvelope), with where it came from noted;
// - a reminder to a signer, through the envelope page's own path.

export const ADD_IN_PATH = "/api/workspace/add-in";

/** The URL the provider calls for one action, from the site's address. */
export function addInEndpointUrl(siteUrl: string, action: string): string {
  return `${siteUrl.replace(/\/+$/, "")}${ADD_IN_PATH}/${action}`;
}

/** This site's own address, or null when it does not know it. */
export function addInSiteUrl(env: EnvSource = process.env): string | null {
  try {
    return resolveAuthUrl(env)?.replace(/\/+$/, "") || null;
  } catch {
    return null;
  }
}

const PRIVATE_HOST =
  /^(localhost|.*\.localhost|.*\.local|.*\.internal|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|0\.0\.0\.0|\[::1?\]|\[f[cd][0-9a-f]*:.*\])$/i;

/**
 * Why the provider cannot call the add-in at this site's address, or null
 * when it can: providers call add-ins only at a public HTTPS address.
 */
export function addInAddressProblem(siteUrl: string | null): string | null {
  let url: URL | null = null;

  try {
    url = siteUrl ? new URL(siteUrl) : null;
  } catch {
    url = null;
  }

  if (!url) {
    return "This site does not know its own address. Set APP_URL where it runs.";
  }

  if (url.protocol !== "https:" || PRIVATE_HOST.test(url.hostname)) {
    return `The add-in is called at this site's address, which has to be public HTTPS; ${url.origin} is not. Give the site a public address and set APP_URL to it.`;
  }

  return null;
}

export type AddInAccount = { email: string; id: string; name: string };

export type AddInAccountLookup =
  | { account: AddInAccount; kind: "found" }
  | { kind: "no_account" }
  | { kind: "unverified" };

/**
 * The account with this address, which the provider has verified. Only an
 * account whose own address is verified is a match, as for sending from
 * the app.
 */
export async function findAddInAccount(
  email: string,
  database: DbExecutor = getDb(),
): Promise<AddInAccountLookup> {
  const row = await queryOne<{
    email: string;
    emailVerified: boolean;
    id: string;
    name: string | null;
  }>(
    database,
    `
      SELECT id, name, email, "emailVerified"
      FROM public."user"
      WHERE lower(email) = $1
      LIMIT 1
    `,
    [email.trim().toLowerCase()],
  );

  if (!row) {
    return { kind: "no_account" };
  }

  if (!row.emailVerified) {
    return { kind: "unverified" };
  }

  return {
    account: {
      email: row.email,
      id: row.id,
      name: row.name?.trim() || row.email,
    },
    kind: "found",
  };
}

// One person's documents sent from an add-in, per hour: converting and
// storing a document is the heaviest thing an add-in does.
const SEND_LIMIT = 30;
const SEND_WINDOW_MS = 60 * 60 * 1000;

export async function addInSendAllowed(userId: string): Promise<boolean> {
  const decision = await consumeRateLimit({
    key: `workspace-add-in-send:${userId}`,
    limit: SEND_LIMIT,
    windowMs: SEND_WINDOW_MS,
  });

  return decision.allowed;
}

/** A title for the draft from the document's name. */
export function addInDraftTitle(fileName: string): string {
  const title = fileName
    .replace(/\.pdf$/i, "")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160)
    .trim();

  return title || "Untitled document";
}

export type AddInDraft = {
  envelopeId: string;
  /** Where the person continues on this site: choosing the signers. */
  path: string;
  /** Whether the suggested signer was added. */
  signerAdded: boolean;
};

/**
 * A draft from a document sent from an add-in, made the same way as an
 * upload: the same size limit and PDF checks, storage and audit event. The
 * source is noted, and a signer can be suggested (the sender of an email);
 * the draft is made even when either of those fails.
 */
export async function createAddInDraft(
  input: {
    bytes: Uint8Array;
    fileName: string;
    signer?: { email: string; name: string } | null;
    source: EnvelopeSource;
    userId: string;
  },
  {
    database = getDb(),
    storageService,
  }: { database?: DbPool; storageService?: StorageService } = {},
): Promise<AddInDraft> {
  const result = await createDraftEnvelope(
    input.userId,
    {
      sourcePdf: {
        body: input.bytes,
        contentType: "application/pdf",
        filename: input.fileName,
      },
      title: addInDraftTitle(input.fileName),
    },
    { database, ...(storageService ? { storageService } : {}) },
  );
  const envelopeId = result.envelope.id;

  await recordEnvelopeSource(
    { envelopeId, source: input.source, userId: input.userId },
    database,
  ).catch((error: unknown) => {
    console.warn(
      `[workspace] Noting where draft ${envelopeId} came from failed:`,
      error instanceof Error ? error.message : error,
    );
  });

  let signerAdded = false;

  if (input.signer) {
    try {
      await replaceDraftEnvelopeSigners(
        input.userId,
        envelopeId,
        { signers: [input.signer] },
        database,
      );
      signerAdded = true;
    } catch (error) {
      // The signers are chosen on the next page anyway.
      console.warn(
        `[workspace] Suggesting a signer for draft ${envelopeId} failed:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return {
    envelopeId,
    path: buildCreateEnvelopeResponse(result).redirectPath,
    signerAdded,
  };
}

/**
 * What the person is told when a draft could not be made, or null for a
 * failure that is not theirs to fix (to be logged).
 */
export function describeAddInDraftFailure(error: unknown): string | null {
  if (
    error instanceof DocumentImportError ||
    error instanceof FileImportError ||
    error instanceof EnvelopeMutationError
  ) {
    return error.message;
  }

  return null;
}

/**
 * Sends a reminder for one of the person's envelopes, with the same limit
 * as the envelope page's button. Returns what to tell them; a failure that
 * is not theirs to fix is thrown.
 */
export async function nudgeFromAddIn(
  account: AddInAccount,
  envelopeId: string,
): Promise<string> {
  // The same count as the envelope page's button (api/envelopes/[id]/nudge).
  const decision = await consumeRateLimit({
    key: `envelope-nudge:${account.id}:${envelopeId}`,
    limit: 5,
    windowMs: 60 * 60 * 1000,
  });

  if (!decision.allowed) {
    return "Too many reminders for this envelope. Try again later.";
  }

  try {
    // Only the sender's own envelope, and only once the wait since the
    // last reminder is over; sendManualEnvelopeNudge checks both.
    const result = await sendManualEnvelopeNudge(account.id, envelopeId, {
      senderEmail: account.email,
      senderName: account.name,
    });

    return `Reminder sent to ${result.signerName}.`;
  } catch (error) {
    if (error instanceof ReminderMutationError) {
      return error.message;
    }

    throw error;
  }
}
