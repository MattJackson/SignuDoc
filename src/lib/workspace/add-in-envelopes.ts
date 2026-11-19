import { type DbExecutor, getDb, queryMany } from "../db/connection.ts";
import { isManualNudgeAvailable } from "../services/reminders.ts";
import type { EnvelopeStatus } from "../types/domain.ts";

// The envelopes a workspace add-in lists beside an email or a selected
// file, and where a draft made from the add-in came from. Any provider's
// add-in uses these (types.ts, WorkspaceAddIn).
//
// Only the person's own envelopes are listed, drafts included: the panel
// is for their own work, and someone else's draft is never theirs to see.
//
// "Nudge" is offered only on envelopes waiting on a signer, as on the
// envelope page; the reminder itself still goes through
// sendManualEnvelopeNudge (reminders.ts), which applies the wait between
// reminders and checks the sender again.

export const MAX_ADD_IN_ENVELOPES = 10;

/** Where a draft's document came from, in the provider's terms. */
export type EnvelopeSource = {
  /** "mail" for an email's attachment, "file" for a file. */
  kind: "file" | "mail";
  /** The provider's id, such as "google". */
  provider: string;
  /** The file's id, or the message and the part. At most 512 characters. */
  ref: string;
};

export type AddInEnvelope = {
  /** Someone is waiting to sign, and a reminder may go now. */
  canNudge: boolean;
  id: string;
  status: EnvelopeStatus;
  title: string;
  updatedAt: number;
};

type EnvelopeRow = {
  expiresAt: number | null;
  id: string;
  lastNudgedAt: number | null;
  status: EnvelopeStatus;
  title: string;
  updatedAt: number;
  waitingSigners: number;
};

function toEnvelopes(
  rows: EnvelopeRow[],
  nowUnixTimestamp: number,
): AddInEnvelope[] {
  return rows.map((row) => ({
    canNudge:
      row.status === "sent" &&
      row.waitingSigners > 0 &&
      (row.expiresAt === null || Number(row.expiresAt) > nowUnixTimestamp) &&
      isManualNudgeAvailable(
        row.lastNudgedAt === null ? null : Number(row.lastNudgedAt),
        nowUnixTimestamp,
      ),
    id: row.id,
    status: row.status,
    title: row.title,
    updatedAt: Number(row.updatedAt),
  }));
}

// Every column the panel shows, with the signers waiting counted. Of
// those, the one reminded longest ago decides whether a reminder can go
// now; sendManualEnvelopeNudge reminds each one that may be.
const ENVELOPE_COLUMNS = `
  envelopes.id,
  envelopes.title,
  envelopes.status,
  envelopes.updated_at AS "updatedAt",
  envelopes.expires_at AS "expiresAt",
  (
    SELECT count(*)::int FROM signers waiting
    WHERE waiting.envelope_id = envelopes.id
      AND waiting.role = 'signer'
      AND waiting.status = 'notified'
  ) AS "waitingSigners",
  (
    SELECT min(coalesce(waiting.last_nudged_at, 0))::bigint
    FROM signers waiting
    WHERE waiting.envelope_id = envelopes.id
      AND waiting.role = 'signer'
      AND waiting.status = 'notified'
  ) AS "lastNudgedAt"
`;

type ListOptions = {
  database?: DbExecutor;
  limit?: number;
  nowUnixTimestamp?: number;
};

function clampLimit(limit: number): number {
  return Math.min(Math.max(Math.trunc(limit), 1), 50);
}

/**
 * The person's envelopes that involve this address, as a signer or as
 * someone receiving a copy. Newest first.
 */
export async function listEnvelopesWithEmail(
  userId: string,
  email: string,
  {
    database = getDb(),
    limit = MAX_ADD_IN_ENVELOPES,
    nowUnixTimestamp = Math.floor(Date.now() / 1000),
  }: ListOptions = {},
): Promise<AddInEnvelope[]> {
  const rows = await queryMany<EnvelopeRow>(
    database,
    `
      SELECT ${ENVELOPE_COLUMNS}
      FROM envelopes
      WHERE envelopes.user_id = $1
        AND EXISTS (
          SELECT 1 FROM signers involved
          WHERE involved.envelope_id = envelopes.id
            AND lower(involved.email) = $2
        )
      ORDER BY envelopes.updated_at DESC, envelopes.id ASC
      LIMIT $3
    `,
    [userId, email.trim().toLowerCase(), clampLimit(limit)],
  );

  return toEnvelopes(rows, nowUnixTimestamp);
}

/** The person's envelopes made from this source. Newest first. */
export async function listEnvelopesFromSource(
  userId: string,
  source: EnvelopeSource,
  {
    database = getDb(),
    limit = MAX_ADD_IN_ENVELOPES,
    nowUnixTimestamp = Math.floor(Date.now() / 1000),
  }: ListOptions = {},
): Promise<AddInEnvelope[]> {
  const rows = await queryMany<EnvelopeRow>(
    database,
    `
      SELECT ${ENVELOPE_COLUMNS}
      FROM envelopes
      WHERE envelopes.user_id = $1
        AND envelopes.source_provider = $2
        AND envelopes.source_kind = $3
        AND envelopes.source_ref = $4
      ORDER BY envelopes.updated_at DESC, envelopes.id ASC
      LIMIT $5
    `,
    [
      userId,
      source.provider,
      source.kind,
      source.ref.slice(0, 512),
      clampLimit(limit),
    ],
  );

  return toEnvelopes(rows, nowUnixTimestamp);
}

/**
 * Notes where a draft's document came from. Only on the person's own
 * draft, and only once: a source already noted is left as it is.
 */
export async function recordEnvelopeSource(
  input: { envelopeId: string; source: EnvelopeSource; userId: string },
  database: DbExecutor = getDb(),
): Promise<void> {
  await database.query(
    `
      UPDATE envelopes
      SET source_provider = $3, source_kind = $4, source_ref = $5
      WHERE id = $1
        AND user_id = $2
        AND status = 'draft'
        AND source_ref IS NULL
    `,
    [
      input.envelopeId,
      input.userId,
      input.source.provider,
      input.source.kind,
      input.source.ref.slice(0, 512),
    ],
  );
}
