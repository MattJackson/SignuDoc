import { type DbExecutor, getDb, queryOne } from "./db/connection.ts";

// Who may see an envelope, and who may change it.
//
// * Its sender sees it and is the only one who changes it: edit, send,
//   remind, change the deadline, correct a signer, void, copy, save as a
//   template, and delete a draft. Every one of those still asks for
//   `user_id = $1` itself and does not go through here.
// * Someone on a team with the sender sees it once it has been sent: its
//   status, its signers, its timeline, its audit trail and, when it is
//   finished, its signed PDF and certificate.
// * An administrator sees every envelope that has been sent, the same way.
//
// A draft is the sender's alone, whoever is asking. An administrator may
// also ask for any finished envelope to be deleted (envelope-deletion.ts);
// a teammate may not.

export const envelopeScopes = ["mine", "team", "all"] as const;

/**
 * Which envelopes a list shows. "mine": the ones you sent. "team": yours
 * and the sent ones of people on your teams. "all": every one you can see,
 * which for an administrator is every sent envelope.
 */
export type EnvelopeScope = (typeof envelopeScopes)[number];

export function parseEnvelopeScope(value: unknown): EnvelopeScope {
  return typeof value === "string" &&
    (envelopeScopes as readonly string[]).includes(value)
    ? (value as EnvelopeScope)
    : "mine";
}

/**
 * SQL that is true when the person in `viewer` shares a team with the
 * owner of the envelope row named by `alias`.
 */
function sharesTeamCondition(viewer: string, alias: string): string {
  return `EXISTS (
    SELECT 1
    FROM team_members viewer_membership
    JOIN team_members owner_membership
      ON owner_membership.team_id = viewer_membership.team_id
    WHERE viewer_membership.user_id = ${viewer}
      AND owner_membership.user_id = ${alias}.user_id
  )`;
}

function isAdminCondition(viewer: string): string {
  return `EXISTS (
    SELECT 1 FROM public."user" viewer_account
    WHERE viewer_account.id = ${viewer} AND viewer_account.role = 'admin'
  )`;
}

/**
 * SQL that is true when the person whose id is the parameter `viewer` (for
 * example "$1") may read the envelope row named by `alias`.
 */
export function readableEnvelopeCondition(
  viewer: string,
  alias = "envelopes",
): string {
  return `(
    ${alias}.user_id = ${viewer}
    OR (
      ${alias}.status <> 'draft'
      AND (${isAdminCondition(viewer)} OR ${sharesTeamCondition(viewer, alias)})
    )
  )`;
}

/** SQL for the envelopes one list scope shows. */
export function envelopeScopeCondition(
  scope: EnvelopeScope,
  viewer: string,
  alias = "envelopes",
): string {
  switch (scope) {
    case "mine":
      return `${alias}.user_id = ${viewer}`;
    case "team":
      return `(
        ${alias}.user_id = ${viewer}
        OR (${alias}.status <> 'draft' AND ${sharesTeamCondition(viewer, alias)})
      )`;
    case "all":
      return readableEnvelopeCondition(viewer, alias);
  }
}

export type EnvelopeAccess = {
  /** The sender may change the envelope; anyone else may only read it. */
  canManage: boolean;
  ownerId: string;
};

/**
 * Whether `viewerId` may read the envelope, and whether they sent it. Null
 * when the envelope does not exist or is not theirs to see, which callers
 * answer with "not found" either way.
 */
export async function getEnvelopeAccess(
  viewerId: string,
  envelopeId: string,
  database: DbExecutor = getDb(),
): Promise<EnvelopeAccess | null> {
  const row = await queryOne<{ ownerId: string }>(
    database,
    `
      SELECT envelopes.user_id AS "ownerId"
      FROM envelopes
      WHERE envelopes.id = $2
        AND ${readableEnvelopeCondition("$1")}
    `,
    [viewerId, envelopeId],
  );

  return row
    ? { canManage: row.ownerId === viewerId, ownerId: row.ownerId }
    : null;
}

// Whose envelope a signed-in account is looking at, as its sender or as an
// administrator: the routes that read, download and delete an envelope ask
// this first and then act as its sender, so an administrator's copy of
// someone else's file can be put on record. A teammate is not covered
// here; the reads themselves let them in (readableEnvelopeCondition).

export type EnvelopeViewerAccess = {
  ownerEmail: string;
  ownerName: string | null;
  ownerUserId: string;
  /** False when an administrator is looking at someone else's envelope. */
  viewerIsOwner: boolean;
};

type AccessRow = {
  ownerEmail: string;
  ownerName: string | null;
  ownerUserId: string;
  status: string;
  viewerRole: string | null;
};

/**
 * The envelope's sender, when `viewerUserId` may see it: as its sender, or
 * as an administrator. Null when the envelope does not exist or is not
 * theirs to see, which callers report as "not found".
 */
export async function resolveEnvelopeViewerAccess(
  viewerUserId: string,
  envelopeId: string,
  database: DbExecutor = getDb(),
): Promise<EnvelopeViewerAccess | null> {
  const row = await queryOne<AccessRow>(
    database,
    `
      SELECT
        e.user_id AS "ownerUserId",
        owner.email AS "ownerEmail",
        owner.name AS "ownerName",
        e.status,
        (SELECT role FROM public."user" WHERE id = $2) AS "viewerRole"
      FROM envelopes e
      JOIN public."user" owner ON owner.id = e.user_id
      WHERE e.id = $1
    `,
    [envelopeId, viewerUserId],
  );

  if (!row) {
    return null;
  }

  const viewerIsOwner = row.ownerUserId === viewerUserId;

  // Someone else's envelope only for an administrator, and never their
  // draft.
  if (
    !viewerIsOwner &&
    (row.viewerRole !== "admin" || row.status === "draft")
  ) {
    return null;
  }

  return {
    ownerEmail: row.ownerEmail,
    ownerName: row.ownerName,
    ownerUserId: row.ownerUserId,
    viewerIsOwner,
  };
}

/** How an administrator sees who sent an envelope. */
export function formatEnvelopeOwner(
  access: Pick<EnvelopeViewerAccess, "ownerEmail" | "ownerName">,
): string {
  const name = access.ownerName?.trim();

  return name ? `${name} (${access.ownerEmail})` : access.ownerEmail;
}
