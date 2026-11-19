import { type DbExecutor, getDb, queryOne } from "../db/connection.ts";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  secretKeyFor,
} from "../services/seal-identity.ts";
import type { EnvSource } from "../utils/env.ts";

// Each person's own connection to their workspace files
// (workspace_file_connections), whichever provider made it: the refresh
// token it gave, encrypted, and which account agreed.
//
// The token is encrypted the way the seal key is (seal-identity.ts), with a
// key derived from the auth secret for this purpose, the provider and the
// person's id, so a row copied to another account cannot be read. If the
// auth secret changes, the token cannot be read any more and the person is
// asked to connect again.

const KEY_CONTEXT = "signudoc/workspace-file-connections/v1";

export type StoredFileConnection = {
  accountEmail: string;
  accountId: string;
  createdAt: number;
  /** Encrypted. */
  refreshToken: string;
  scope: string;
  updatedAt: number;
  userId: string;
};

/** Where connections are kept: Postgres, or a stand-in in tests. */
export interface FileConnectionRepository {
  /**
   * Removes the connection. Given the encrypted refresh token that was
   * read, only a connection still holding it is removed, so one saved in
   * the meantime is left alone.
   */
  delete(
    userId: string,
    expectedRefreshToken?: string,
  ): Promise<StoredFileConnection | null>;
  read(userId: string): Promise<StoredFileConnection | null>;
  write(connection: StoredFileConnection): Promise<void>;
}

function keyFor(provider: string, userId: string, env: EnvSource): Buffer {
  return secretKeyFor(`${KEY_CONTEXT}/${provider}/${userId}`, env);
}

export function sealRefreshToken(
  token: string,
  provider: string,
  userId: string,
  env: EnvSource = process.env,
): string {
  return encryptPrivateKey(token, keyFor(provider, userId, env));
}

/** The token, or null when it cannot be read with this secret. */
export function openRefreshToken(
  sealed: string,
  provider: string,
  userId: string,
  env: EnvSource = process.env,
): string | null {
  return decryptPrivateKey(sealed, keyFor(provider, userId, env));
}

const SELECT_COLUMNS = `
  user_id AS "userId",
  account_id AS "accountId",
  account_email AS "accountEmail",
  refresh_token AS "refreshToken",
  scope,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

export function createPostgresFileConnectionRepository(
  provider: string,
  database?: DbExecutor,
): FileConnectionRepository {
  // Read when used, so making a repository needs no database.
  const db = () => database ?? getDb();

  return {
    async delete(userId, expectedRefreshToken) {
      return queryOne<StoredFileConnection>(
        db(),
        `
          DELETE FROM workspace_file_connections
          WHERE user_id = $1 AND provider = $2
            AND ($3::text IS NULL OR refresh_token = $3)
          RETURNING ${SELECT_COLUMNS}
        `,
        [userId, provider, expectedRefreshToken ?? null],
      );
    },
    async read(userId) {
      return queryOne<StoredFileConnection>(
        db(),
        `
          SELECT ${SELECT_COLUMNS} FROM workspace_file_connections
          WHERE user_id = $1 AND provider = $2
        `,
        [userId, provider],
      );
    },
    async write(connection) {
      await db().query(
        `
          INSERT INTO workspace_file_connections (
            user_id, provider, account_id, account_email, refresh_token,
            scope, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (user_id, provider) DO UPDATE SET
            account_id = excluded.account_id,
            account_email = excluded.account_email,
            refresh_token = excluded.refresh_token,
            scope = excluded.scope,
            updated_at = excluded.updated_at
        `,
        [
          connection.userId,
          provider,
          connection.accountId,
          connection.accountEmail,
          connection.refreshToken,
          connection.scope,
          connection.createdAt,
          connection.updatedAt,
        ],
      );
    },
  };
}
