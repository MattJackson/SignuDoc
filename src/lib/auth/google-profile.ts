import type { DbExecutor } from "../db/connection.ts";

// A person's name and profile picture from Google sign-in, taken when the
// account is made and refreshed at every Google sign-in after, so the
// avatar shows their Google photo instead of initials.
//
// Only pictures on lh3.googleusercontent.com are kept: that is where Google
// serves profile photos, and the one image host the site's Content
// Security Policy allows (src/proxy.ts).

export const GOOGLE_PICTURE_HOST = "lh3.googleusercontent.com";
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
      url.hostname === GOOGLE_PICTURE_HOST &&
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

  const result = await database.query(
    `
      UPDATE "user"
      SET
        name = COALESCE($1, name),
        image = COALESCE($2, image),
        "updatedAt" = $3
      WHERE lower(email) = $4
    `,
    [
      profile.name,
      profile.image,
      now.toISOString(),
      email.trim().toLowerCase(),
    ],
  );

  return (result.rowCount ?? 0) > 0;
}
