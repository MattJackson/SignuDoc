import { z } from "zod";

// The event object Google posts to each of the add-on's endpoints, reduced
// to what SignuDoc reads. The shapes are Google's:
// https://developers.google.com/workspace/add-ons/concepts/event-objects
// and, for HTTP add-ons, authorizationEventObject:
// https://developers.google.com/workspace/add-ons/guides/alternate-runtimes
//
// - commonEventObject: which app (GMAIL, DRIVE), and the parameters of the
//   button that was pressed, as a map of strings.
// - authorizationEventObject: systemIdToken, userIdToken, and
//   userOAuthToken, the user's own access token for the scopes the add-on
//   asks for (Gmail add-on scopes and drive.file).
// - gmail: the open message's id, and an access token for that message
//   only (the gmail.addons.current.message.readonly scope), sent to the
//   Gmail API in the X-Goog-Gmail-Access-Token header.
// - drive: the selected items, each with addonHasFileScopePermission,
//   true once the user has given the add-on that file (drive.file).
//
// Anything unexpected is dropped rather than refused, so a field Google
// adds later does not break the add-on. A token that is missing is an
// empty string, which fails verification.

const MAX_TOKEN = 8192;
const MAX_ID = 512;

const shortText = z.string().max(MAX_ID);

const driveItemSchema = z.object({
  addonHasFileScopePermission: z.boolean().optional(),
  id: shortText,
  iconUrl: z.string().max(2048).optional(),
  mimeType: z.string().max(255).optional(),
  // Cut to length rather than refusing the whole request.
  title: z
    .string()
    .transform((title) => title.slice(0, 1024))
    .optional(),
});

const eventSchema = z.object({
  authorizationEventObject: z
    .object({
      systemIdToken: z.string().max(MAX_TOKEN).optional(),
      userIdToken: z.string().max(MAX_TOKEN).optional(),
      userOAuthToken: z.string().max(MAX_TOKEN).optional(),
    })
    .optional(),
  commonEventObject: z
    .object({
      hostApp: z.string().max(32).optional(),
      parameters: z.record(z.string(), z.string().max(2048)).optional(),
      platform: z.string().max(32).optional(),
      userLocale: z.string().max(64).optional(),
    })
    .optional(),
  drive: z
    .object({
      activeCursorItem: driveItemSchema.optional(),
      // A long selection is cut to its first 100, not refused.
      selectedItems: z
        .array(z.unknown())
        .transform((items) => items.slice(0, 100))
        .pipe(z.array(driveItemSchema))
        .optional(),
    })
    .optional(),
  gmail: z
    .object({
      accessToken: z.string().max(MAX_TOKEN).optional(),
      messageId: shortText.optional(),
      threadId: shortText.optional(),
    })
    .optional(),
});

export type AddonDriveItem = {
  hasFileScope: boolean;
  id: string;
  mimeType: string;
  title: string;
};

export type AddonHostApp = "drive" | "gmail" | "other";

export type AddonEvent = {
  drive: { selectedItems: AddonDriveItem[] } | null;
  gmail: {
    accessToken: string;
    messageId: string;
    threadId: string | null;
  } | null;
  hostApp: AddonHostApp;
  parameters: Record<string, string>;
  systemIdToken: string;
  userIdToken: string;
  userOAuthToken: string;
};

export class AddonEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddonEventError";
  }
}

function toHostApp(value: string | undefined): AddonHostApp {
  switch (value?.toUpperCase()) {
    case "GMAIL":
      return "gmail";
    case "DRIVE":
      return "drive";
    default:
      return "other";
  }
}

/** Reads the event Google sent, or throws AddonEventError. */
export function parseAddonEvent(body: unknown): AddonEvent {
  const parsed = eventSchema.safeParse(body);

  if (!parsed.success) {
    throw new AddonEventError("The add-on event could not be read.");
  }

  const event = parsed.data;
  const gmail = event.gmail;
  const items = event.drive?.selectedItems ?? [];
  const cursor = event.drive?.activeCursorItem;
  // The selection, or the item under the cursor when nothing is selected.
  const selected = items.length > 0 ? items : cursor ? [cursor] : [];

  return {
    drive: event.drive
      ? {
          selectedItems: selected.map((item) => ({
            hasFileScope: item.addonHasFileScopePermission === true,
            id: item.id,
            mimeType: item.mimeType ?? "",
            title: item.title ?? "Untitled",
          })),
        }
      : null,
    gmail:
      gmail?.messageId && gmail.accessToken
        ? {
            accessToken: gmail.accessToken,
            messageId: gmail.messageId,
            threadId: gmail.threadId ?? null,
          }
        : null,
    hostApp: toHostApp(event.commonEventObject?.hostApp),
    parameters: event.commonEventObject?.parameters ?? {},
    systemIdToken: event.authorizationEventObject?.systemIdToken ?? "",
    userIdToken: event.authorizationEventObject?.userIdToken ?? "",
    userOAuthToken: event.authorizationEventObject?.userOAuthToken ?? "",
  };
}

/** The bearer token in an Authorization header, or an empty string. */
export function readBearerToken(header: string | null): string {
  const match = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "");

  return match ? match[1]! : "";
}
