import type { DbExecutor } from "../db/connection.ts";

// A person's name and profile picture from Google sign-in, taken when the
// account is made and refreshed at every Google sign-in after, so the
// avatar shows their Google photo instead of initials.
//
// Only pictures on lh3 to lh6.googleusercontent.com are kept: those are
// where Google serves profile photos, and the only image hosts the site's
// Content Security Policy allows (src/proxy.ts).

export const GOOGLE_PICTURE_HOSTS = [
  "lh3.googleusercontent.com",
  "lh4.googleusercontent.com",
  "lh5.googleusercontent.com",
  "lh6.googleusercontent.com",
] as const;
const MAX_NAME_LENGTH = 200;
const MAX_PICTURE_LENGTH = 2048;

export type GoogleProfile = { image: string | null; name: string | null };

/** The name and picture in an ID token's claims, when they can be used. */
export function readGoogleProfile(
  claims: Record<string, unknown> | null | undefined,
): GoogleProfile {
  const rawName = typeof claims?.name === "string" ? claims.name : "";
  const name = rawName.replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);

  return { image: readPicture(claims?.picture), name: name || null };
}

function readPicture(value: unknown): string | null {
  if (typeof value !== "string" || value.length > MAX_PICTURE_LENGTH) {
    return null;
  }

  try {
    const url = new URL(value);

    return url.protocol === "https:" &&
      (GOOGLE_PICTURE_HOSTS as readonly string[]).includes(url.hostname) &&
      url.port === "" &&
      !url.username &&
      !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** The fields to give a new account, leaving out what Google did not send. */
export function googleProfileFields(
  claims: Record<string, unknown> | null | undefined,
): { image?: string; name?: string } {
  const profile = readGoogleProfile(claims);

  return {
    ...(profile.image ? { image: profile.image } : {}),
    ...(profile.name ? { name: profile.name } : {}),
  };
}

/**
 * Brings an existing account's name and picture up to date with Google.
 * What Google did not send is left as it is. True when the account was
 * found.
 */
export async function syncGoogleProfile(
  email: string,
  claims: Record<string, unknown> | null | undefined,
  database: DbExecutor,
  now: Date = new Date(),
): Promise<boolean> {
  const profile = readGoogleProfile(claims);

  if (!profile.name && !profile.image) {
    return false;
  }

  const target = email.trim().toLowerCase();
  const current = await database.query<{
    id: string;
    image: string | null;
    name: string | null;
  }>(`SELECT id, name, image FROM "user" WHERE lower(email) = $1`, [target]);
  const account = current.rows[0];

  if (!account) {
    return false;
  }

  const name = profile.name ?? account.name;
  const image = profile.image ?? account.image;

  // Most sign-ins bring nothing new, so they leave the account alone.
  if (name === account.name && image === account.image) {
    return true;
  }

  await database.query(
    `UPDATE "user" SET name = $1, image = $2, "updatedAt" = $3 WHERE id = $4`,
    [name, image, now.toISOString(), account.id],
  );

  return true;
}
