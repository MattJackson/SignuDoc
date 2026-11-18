import { createHash } from "node:crypto";

import {
  type DbExecutor,
  type DbPool,
  getDb,
  queryOne,
  withTransaction,
} from "../../db/connection.ts";
import { getIntegrationSettings } from "../../integration-settings.ts";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  secretKeyFor,
} from "../../services/seal-identity.ts";
import { recordSystemAuditEvent } from "../../services/system-audit.ts";
import type { EnvSource } from "../../utils/env.ts";
import type { FetchLike } from "./drive-api.ts";
import {
  DriveAuthorizationError,
  readDriveOAuthClient,
  refreshAccessToken,
  revokeToken,
  type DriveOAuthClient,
} from "./drive-oauth.ts";

// Each person's Google Drive connection: the refresh token Google gave for
// drive.file, stored encrypted (google_drive_tokens), and the access tokens
// made from it, kept in memory until shortly before they run out.
//
// The refresh token is encrypted with a key derived from the auth secret
// and the person's id, so a row copied to another account cannot be read.
// If Google stops accepting it (the person removed the app from their
// Google account, or an administrator did), the row is deleted and the
// person is asked to connect again.

const TOKEN_CONTEXT = "signudoc/google-drive-tokens/v1";
// An access token is used again until this long before it runs out.
const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const MAX_CACHED_TOKENS = 1000;

export type StoredDriveConnection = {
  createdAt: number;
  googleEmail: string;
  googleSubject: string;
  /** Encrypted. */
  refreshToken: string;
  scope: string;
  updatedAt: number;
  userId: string;
};

/** Where connections are kept: Postgres, or a stand-in in tests. */
export interface DriveConnectionRepository {
  delete(userId: string): Promise<StoredDriveConnection | null>;
  read(userId: string): Promise<StoredDriveConnection | null>;
  write(connection: StoredDriveConnection): Promise<void>;
}

export type DriveConnection = {
  connectedAt: number;
  googleEmail: string;
  googleSubject: string;
};

type CachedAccessToken = {
  accessToken: string;
  expiresAtMs: number;
  /** Which refresh token made it, so a new connection is not answered by an old token. */
  refreshTokenHash: string;
};

declare global {
  var __signudocDriveAccessTokens: Map<string, CachedAccessToken> | undefined;
}

function accessTokenCache(): Map<string, CachedAccessToken> {
  globalThis.__signudocDriveAccessTokens ??= new Map();

  return globalThis.__signudocDriveAccessTokens;
}

function keyFor(userId: string, env: EnvSource): Buffer {
  return secretKeyFor(`${TOKEN_CONTEXT}/${userId}`, env);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

type ConnectionRow = {
  createdAt: number;
  googleEmail: string;
  googleSubject: string;
  refreshToken: string;
  scope: string;
  updatedAt: number;
  userId: string;
};

const SELECT_COLUMNS = `
  user_id AS "userId",
  google_subject AS "googleSubject",
  google_email AS "googleEmail",
  refresh_token AS "refreshToken",
  scope,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export function createPostgresDriveConnectionRepository(
  database: DbExecutor = getDb(),
): DriveConnectionRepository {
  return {
    async delete(userId) {
      return queryOne<ConnectionRow>(
        database,
        `DELETE FROM google_drive_tokens WHERE user_id = $1 RETURNING ${SELECT_COLUMNS}`,
        [userId],
      );
    },
    async read(userId) {
      return queryOne<ConnectionRow>(
        database,
        `SELECT ${SELECT_COLUMNS} FROM google_drive_tokens WHERE user_id = $1`,
        [userId],
      );
    },
    async write(connection) {
      await database.query(
        `
          INSERT INTO google_drive_tokens (
            user_id, google_subject, google_email, refresh_token, scope,
            created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (user_id) DO UPDATE SET
            google_subject = excluded.google_subject,
            google_email = excluded.google_email,
            refresh_token = excluded.refresh_token,
            scope = excluded.scope,
            updated_at = excluded.updated_at
        `,
        [
          connection.userId,
          connection.googleSubject,
          connection.googleEmail,
          connection.refreshToken,
          connection.scope,
          connection.createdAt,
          connection.updatedAt,
        ],
      );
    },
  };
}

export type DriveTokenStoreOptions = {
  env?: EnvSource;
  fetchImpl?: FetchLike;
  /** The OAuth client; read from the settings when not given. */
  loadClient?: () => Promise<DriveOAuthClient | null>;
  now?: () => number;
  repository?: DriveConnectionRepository;
};

export function createDriveTokenStore({
  env = process.env,
  fetchImpl = fetch,
  loadClient,
  now = Date.now,
  repository = createPostgresDriveConnectionRepository(),
}: DriveTokenStoreOptions = {}) {
  const cache = accessTokenCache();
  const inFlight = new Map<string, Promise<string>>();

  async function client(): Promise<DriveOAuthClient> {
    const value = loadClient
      ? await loadClient()
      : readDriveOAuthClient(env, await getIntegrationSettings(env));

    if (!value) {
      throw new DriveAuthorizationError(
        "not_configured",
        "Google sign-in is not set up, so Google Drive cannot be used.",
      );
    }

    return value;
  }

  async function getConnection(
    userId: string,
  ): Promise<DriveConnection | null> {
    const row = await repository.read(userId);

    return row
      ? {
          connectedAt: row.createdAt,
          googleEmail: row.googleEmail,
          googleSubject: row.googleSubject,
        }
      : null;
  }

  /** Stores a new connection, replacing any earlier one. */
  async function save(input: {
    googleEmail: string;
    googleSubject: string;
    refreshToken: string;
    scope: string;
    userId: string;
  }): Promise<void> {
    const seconds = Math.floor(now() / 1000);
    const existing = await repository.read(input.userId);

    await repository.write({
      createdAt: existing?.createdAt ?? seconds,
      googleEmail: input.googleEmail,
      googleSubject: input.googleSubject,
      refreshToken: encryptPrivateKey(
        input.refreshToken,
        keyFor(input.userId, env),
      ),
      scope: input.scope,
      updatedAt: seconds,
      userId: input.userId,
    });
    cache.delete(input.userId);

    // The earlier token is no longer needed; Google is asked to forget it.
    const previous = existing
      ? decryptPrivateKey(existing.refreshToken, keyFor(input.userId, env))
      : null;

    if (previous && previous !== input.refreshToken) {
      await revokeToken(previous, fetchImpl);
    }
  }

  async function refresh(userId: string): Promise<string> {
    const row = await repository.read(userId);

    if (!row) {
      throw new DriveAuthorizationError(
        "not_connected",
        "Connect Google Drive first.",
      );
    }

    const refreshToken = decryptPrivateKey(
      row.refreshToken,
      keyFor(userId, env),
    );

    if (!refreshToken) {
      // The auth secret changed: the token cannot be read any more.
      await repository.delete(userId);
      throw new DriveAuthorizationError(
        "not_connected",
        "Connect Google Drive again.",
      );
    }

    const refreshTokenHash = hashToken(refreshToken);
    const cached = cache.get(userId);

    if (
      cached &&
      cached.refreshTokenHash === refreshTokenHash &&
      cached.expiresAtMs - REFRESH_MARGIN_MS > now()
    ) {
      return cached.accessToken;
    }

    try {
      const token = await refreshAccessToken({
        client: await client(),
        fetchImpl,
        refreshToken,
      });

      if (cache.size >= MAX_CACHED_TOKENS) {
        cache.clear();
      }

      cache.set(userId, {
        accessToken: token.accessToken,
        expiresAtMs: now() + token.expiresInSeconds * 1000,
        refreshTokenHash,
      });

      return token.accessToken;
    } catch (error) {
      if (
        error instanceof DriveAuthorizationError &&
        error.code === "invalid_grant"
      ) {
        await repository.delete(userId);
        cache.delete(userId);
        throw new DriveAuthorizationError(
          "not_connected",
          "Google Drive was disconnected. Connect it again.",
        );
      }

      throw error;
    }
  }

  /** A current access token for the person's Drive (drive.file). */
  async function getAccessToken(userId: string): Promise<string> {
    const cached = cache.get(userId);

    if (cached && cached.expiresAtMs - REFRESH_MARGIN_MS > now()) {
      return cached.accessToken;
    }

    let pending = inFlight.get(userId);

    if (!pending) {
      pending = refresh(userId).finally(() => {
        inFlight.delete(userId);
      });
      inFlight.set(userId, pending);
    }

    return pending;
  }

  /**
   * Revokes the refresh token at Google and forgets the connection. True
   * when there was one.
   */
  async function disconnect(userId: string): Promise<boolean> {
    const row = await repository.delete(userId);

    cache.delete(userId);

    if (!row) {
      return false;
    }

    const refreshToken = decryptPrivateKey(
      row.refreshToken,
      keyFor(userId, env),
    );

    if (refreshToken && !(await revokeToken(refreshToken, fetchImpl))) {
      console.warn(
        "[drive] Google could not be asked to revoke a Drive connection; it was forgotten here.",
      );
    }

    return true;
  }

  return { disconnect, getAccessToken, getConnection, save };
}

export type DriveTokenStore = ReturnType<typeof createDriveTokenStore>;

/** A person's current Drive access token, for the routes. */
export function getUserDriveAccessToken(userId: string): Promise<string> {
  return createDriveTokenStore().getAccessToken(userId);
}

export function getDriveConnection(
  userId: string,
): Promise<DriveConnection | null> {
  return createDriveTokenStore().getConnection(userId);
}

type AuditActor = {
  email: string;
  id: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

/** Saves a connection and records it in the site audit trail. */
export async function connectDrive(
  input: {
    googleEmail: string;
    googleSubject: string;
    refreshToken: string;
    scope: string;
  },
  actor: AuditActor,
  {
    database = getDb(),
    env = process.env,
  }: { database?: DbPool; env?: EnvSource } = {},
): Promise<void> {
  await withTransaction(async (tx) => {
    await createDriveTokenStore({
      env,
      repository: createPostgresDriveConnectionRepository(tx),
    }).save({ ...input, userId: actor.id });
    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.id,
        event: "google_drive_connected",
        ipAddress: actor.ipAddress ?? null,
        metadata: { googleEmail: input.googleEmail, scope: input.scope },
        targetUserId: actor.id,
        userAgent: actor.userAgent ?? null,
      },
      tx,
    );
  }, database);
}

/** Revokes and forgets a connection, and records it in the audit trail. */
export async function disconnectDrive(
  actor: AuditActor,
  {
    database = getDb(),
    env = process.env,
  }: { database?: DbPool; env?: EnvSource } = {},
): Promise<boolean> {
  const removed = await createDriveTokenStore({
    env,
    repository: createPostgresDriveConnectionRepository(database),
  }).disconnect(actor.id);

  if (removed) {
    await recordSystemAuditEvent(
      {
        actorEmail: actor.email,
        actorUserId: actor.id,
        event: "google_drive_disconnected",
        ipAddress: actor.ipAddress ?? null,
        metadata: null,
        targetUserId: actor.id,
        userAgent: actor.userAgent ?? null,
      },
      database,
    );
  }

  return removed;
}
