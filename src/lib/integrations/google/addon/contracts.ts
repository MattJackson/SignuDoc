import { type DbExecutor, getDb, queryMany } from "../../../db/connection.ts";
import { envelopeScopeCondition } from "../../../envelope-access.ts";
import { isManualNudgeAvailable } from "../../../services/reminders.ts";
import type { EnvelopeStatus } from "../../../types/domain.ts";

// The envelopes the add-on lists beside an email or a Drive file. Both go
// through the same access rule as the dashboard's "team" list
// (envelope-access.ts): the viewer's own envelopes, drafts included, and
// the sent ones of people on their teams. Never anyone else's draft.
//
// "Nudge" is offered only on the viewer's own envelopes that are waiting
// on a signer, as on the envelope page; the reminder itself still goes
// through sendManualEnvelopeNudge (reminders.ts), which applies the wait
// between reminders and checks the sender again.

export const MAX_ADDON_CONTRACTS = 10;

export type AddonContract = {
  /** The viewer sent it, and someone is waiting to sign: it can be nudged. */
  canNudge: boolean;
  id: string;
  /** The viewer sent it. */
  mine: boolean;
  ownerEmail: string;
  status: EnvelopeStatus;
  title: string;
  updatedAt: number;
};

type ContractRow = {
  expiresAt: number | null;
  id: string;
  lastNudgedAt: number | null;
  ownerEmail: string;
  status: EnvelopeStatus;
  title: string;
  updatedAt: number;
  userId: string;
  waitingSigners: number;
};

function toContracts(
  rows: ContractRow[],
  viewerId: string,
  nowUnixTimestamp: number,
): AddonContract[] {
  return rows.map((row) => {
    const mine = row.userId === viewerId;

    return {
      canNudge:
        mine &&
        row.status === "sent" &&
        row.waitingSigners > 0 &&
        (row.expiresAt === null || row.expiresAt > nowUnixTimestamp) &&
        isManualNudgeAvailable(row.lastNudgedAt, nowUnixTimestamp),
      id: row.id,
      mine,
      ownerEmail: row.ownerEmail,
      status: row.status,
      title: row.title,
      updatedAt: row.updatedAt,
    };
  });
}

// Every column the cards show, with the waiting signers counted. Of the
// waiting signers, the one reminded longest ago decides whether a reminder
// can go now; sendManualEnvelopeNudge reminds each one that may be.
const CONTRACT_COLUMNS = `
  envelopes.id,
  envelopes.title,
  envelopes.status,
  envelopes.user_id AS "userId",
  envelopes.updated_at AS "updatedAt",
  envelopes.expires_at AS "expiresAt",
  owner.email AS "ownerEmail",
  (
    SELECT count(*)::int FROM signers waiting
    WHERE waiting.envelope_id = envelopes.id
      AND waiting.role = 'signer'
      AND waiting.status = 'notified'
  ) AS "waitingSigners",
  (
    SELECT min(coalesce(waiting.last_nudged_at, 0))::bigint FROM signers waiting
    WHERE waiting.envelope_id = envelopes.id
      AND waiting.role = 'signer'
      AND waiting.status = 'notified'
  ) AS "lastNudgedAt"
`;

/**
 * Envelopes the viewer can see that involve this address: as a signer or
 * as someone receiving a copy. Newest first.
 */
export async function listContractsWithEmail(
  viewerId: string,
  email: string,
  {
    database = getDb(),
    limit = MAX_ADDON_CONTRACTS,
    nowUnixTimestamp = Math.floor(Date.now() / 1000),
  }: { database?: DbExecutor; limit?: number; nowUnixTimestamp?: number } = {},
): Promise<AddonContract[]> {
  const rows = await queryMany<ContractRow>(
    database,
    `
      SELECT ${CONTRACT_COLUMNS}
      FROM envelopes
      JOIN public."user" owner ON owner.id = envelopes.user_id
      WHERE ${envelopeScopeCondition("team", "$1")}
        AND EXISTS (
          SELECT 1 FROM signers involved
          WHERE involved.envelope_id = envelopes.id
            AND lower(involved.email) = $2
        )
      ORDER BY envelopes.updated_at DESC, envelopes.id ASC
      LIMIT $3
    `,
    [viewerId, email.trim().toLowerCase(), Math.min(Math.max(limit, 1), 50)],
  );

  return toContracts(rows, viewerId, nowUnixTimestamp);
}

/** Envelopes the viewer can see that were made from this Drive file. */
export async function listContractsFromDriveFile(
  viewerId: string,
  fileId: string,
  {
    database = getDb(),
    limit = MAX_ADDON_CONTRACTS,
    nowUnixTimestamp = Math.floor(Date.now() / 1000),
  }: { database?: DbExecutor; limit?: number; nowUnixTimestamp?: number } = {},
): Promise<AddonContract[]> {
  const rows = await queryMany<ContractRow>(
    database,
    `
      SELECT ${CONTRACT_COLUMNS}
      FROM envelopes
      JOIN public."user" owner ON owner.id = envelopes.user_id
      WHERE ${envelopeScopeCondition("team", "$1")}
        AND envelopes.source_kind = 'drive'
        AND envelopes.source_ref = $2
      ORDER BY envelopes.updated_at DESC, envelopes.id ASC
      LIMIT $3
    `,
    [viewerId, fileId, Math.min(Math.max(limit, 1), 50)],
  );

  return toContracts(rows, viewerId, nowUnixTimestamp);
}

/**
 * Notes where a draft's document came from. Only on the sender's own
 * draft, and only once: a source already noted is left as it is.
 */
export async function recordEnvelopeSource(
  input: {
    envelopeId: string;
    kind: "drive" | "gmail";
    ref: string;
    userId: string;
  },
  database: DbExecutor = getDb(),
): Promise<void> {
  await database.query(
    `
      UPDATE envelopes
      SET source_kind = $3, source_ref = $4
      WHERE id = $1
        AND user_id = $2
        AND status = 'draft'
        AND source_ref IS NULL
    `,
    [input.envelopeId, input.userId, input.kind, input.ref.slice(0, 512)],
  );
}
