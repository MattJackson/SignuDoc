import { createHash } from "node:crypto";

import type { EnvSource } from "../../../../utils/env.ts";
import {
  createPostgresFileConnectionRepository,
  openRefreshToken,
  sealRefreshToken,
  type FileConnectionRepository,
} from "../../../file-connections.ts";
import { FilesConnectionError, type FilesConnection } from "../../../types.ts";
import type { FetchLike } from "./drive-api.ts";
import {
  InvalidGrantError,
  readDriveOAuthClient,
  refreshAccessToken,
  revokeToken,
  type DriveOAuthClient,
} from "./drive-oauth.ts";

// Each person's Google Drive connection: the refresh token Google gave for
// drive.file, stored encrypted (workspace/file-connections.ts), and the
// access tokens made from it, kept in memory until shortly before they run
// out.
//
// If Google stops accepting the refresh token (the person removed the app
// from their Google account, or an administrator did), the connection is
// deleted and the person is asked to connect again.

// An access token is used again until this long before it runs out.
const REFRESH_MARGIN_MS = 2 * 60 * 1000;
const MAX_CACHED_TOKENS = 1000;

type CachedAccessToken = {
  accessToken: string;
  expiresAtMs: number;
  /** Which refresh token made it, so a new connection is not answered by an old token. */
  refreshTokenHash: string;
};

declare global {
  var __signudocDriveAccessTokens: Map<string, CachedAccessToken> | undefined;
  var __signudocDriveRefreshes: Map<string, Promise<string>> | undefined;
}

function accessTokenCache(): Map<string, CachedAccessToken> {
  globalThis.__signudocDriveAccessTokens ??= new Map();

  return globalThis.__signudocDriveAccessTokens;
}

// Refreshes under way, one per person, shared by every store in the process
// (each request makes a new store).
function refreshesInFlight(): Map<string, Promise<string>> {
  globalThis.__signudocDriveRefreshes ??= new Map();

  return globalThis.__signudocDriveRefreshes;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type DriveTokenStoreOptions = {
  env?: EnvSource;
  fetchImpl?: FetchLike;
  /** The OAuth client; read from the environment when not given. */
  loadClient?: () => DriveOAuthClient | null;
  now?: () => number;
  repository?: FileConnectionRepository;
};

export function createDriveTokenStore({
  env = process.env,
  fetchImpl = fetch,
  loadClient,
  now = Date.now,
  repository = createPostgresFileConnectionRepository("google"),
}: DriveTokenStoreOptions = {}) {
  const cache = accessTokenCache();
  const inFlight = refreshesInFlight();

  function client(): DriveOAuthClient {
    const value = loadClient ? loadClient() : readDriveOAuthClient(env);

    if (!value) {
      throw new FilesConnectionError(
        "not_configured",
        "Google Drive is not set up on this site.",
      );
    }

    return value;
  }

  const open = (sealed: string, userId: string) =>
    openRefreshToken(sealed, "google", userId, env);

  async function getConnection(
    userId: string,
  ): Promise<FilesConnection | null> {
    const row = await repository.read(userId);

    return row
      ? { account: row.accountEmail, connectedAt: row.createdAt }
      : null;
  }

  /**
   * Stores a new connection, replacing any earlier one, and returns the
   * token it replaced. That token is not revoked here: for the same Google
   * account it belongs to the grant the new token also belongs to, so
   * revoking it would end the new connection too (the caller decides).
   */
  async function save(input: {
    accountEmail: string;
    accountId: string;
    refreshToken: string;
    scope: string;
    userId: string;
  }): Promise<{ accountId: string; refreshToken: string } | null> {
    const seconds = Math.floor(now() / 1000);
    const existing = await repository.read(input.userId);

    await repository.write({
      accountEmail: input.accountEmail,
      accountId: input.accountId,
      createdAt: existing?.createdAt ?? seconds,
      refreshToken: sealRefreshToken(
        input.refreshToken,
        "google",
        input.userId,
        env,
      ),
      scope: input.scope,
      updatedAt: seconds,
      userId: input.userId,
    });
    cache.delete(input.userId);

    const previous = existing
      ? open(existing.refreshToken, input.userId)
      : null;

    return existing && previous && previous !== input.refreshToken
      ? { accountId: existing.accountId, refreshToken: previous }
      : null;
  }

  async function refresh(userId: string): Promise<string> {
    const row = await repository.read(userId);

    if (!row) {
      throw new FilesConnectionError(
        "not_connected",
        "Connect Google Drive first.",
      );
    }

    const refreshToken = open(row.refreshToken, userId);

    if (!refreshToken) {
      // The auth secret changed: the token cannot be read any more.
      await repository.delete(userId, row.refreshToken);
      throw new FilesConnectionError(
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
        client: client(),
        env,
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
      if (error instanceof InvalidGrantError) {
        // Only the connection that was tried: one saved meanwhile stays.
        const removed = await repository.delete(userId, row.refreshToken);

        if (removed) {
          cache.delete(userId);
        }

        throw new FilesConnectionError(
          "not_connected",
          "Google Drive was disconnected. Connect it again.",
        );
      }

      throw error;
    }
  }

  /** A current access token for the person's Drive (drive.file). */
  async function getAccessToken(userId: string): Promise<string> {
    // Every call goes through refresh(), which reads the stored connection
    // and answers from the cache only for the refresh token still stored.
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

    const refreshToken = open(row.refreshToken, userId);

    if (
      refreshToken &&
      !(await revokeToken(refreshToken, { env, fetchImpl }))
    ) {
      console.warn(
        "[drive] Google could not be asked to revoke a Drive connection; it was forgotten here.",
      );
    }

    return true;
  }

  return { disconnect, getAccessToken, getConnection, save };
}

export type DriveTokenStore = ReturnType<typeof createDriveTokenStore>;
