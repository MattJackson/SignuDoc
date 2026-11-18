import { MAX_UPLOAD_SIZE_BYTES } from "../../../types/domain.ts";

// The open Gmail message, read through the Gmail API with plain fetch, as
// the person using the add-on. Two tokens go with each call, as Google's
// guide for HTTP add-ons describes
// (https://developers.google.com/workspace/add-ons/guides/alternate-runtimes):
//
// - Authorization: Bearer <userOAuthToken>, the user's own token for the
//   add-on's scopes (gmail.addons.execute and
//   gmail.addons.current.message.readonly);
// - X-Goog-Gmail-Access-Token: <gmail.accessToken>, the event's token for
//   the one message that is open, which is what lets the add-on read it.
//
// The add-on can read only the open message, never the rest of the
// mailbox. Google's error bodies are not passed on, only the status.

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

const SIGNABLE_TYPES = new Map<string, string>([
  ["application/pdf", "pdf"],
  ["application/msword", "word"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "word",
  ],
]);
const SIGNABLE_EXTENSIONS = new Map<string, string>([
  [".pdf", "application/pdf"],
  [".doc", "application/msword"],
  [
    ".docx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
]);

export type GmailMessagePart = {
  body?: { attachmentId?: string; size?: number };
  filename?: string;
  headers?: { name?: string; value?: string }[];
  mimeType?: string;
  partId?: string;
  parts?: GmailMessagePart[];
};

export type GmailMessage = {
  id?: string;
  payload?: GmailMessagePart;
  threadId?: string;
};

export type SignableAttachment = {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  partId: string;
  sizeBytes: number;
  /** Larger than an upload may be, so it cannot be sent from here. */
  tooLarge: boolean;
};

export type GmailSender = { email: string; name: string | null };

export class GmailApiError extends Error {
  readonly status: number | null;

  constructor(message: string, status: number | null) {
    super(message);
    this.name = "GmailApiError";
    this.status = status;
  }
}

/** The MIME type an attachment is signed as, or null when it cannot be. */
export function signableMimeType(
  mimeType: string,
  fileName: string,
): string | null {
  const type = mimeType.trim().toLowerCase();

  if (SIGNABLE_TYPES.has(type)) {
    return type;
  }

  // Mail programs often send documents as application/octet-stream.
  const dot = fileName.lastIndexOf(".");

  return dot >= 0
    ? (SIGNABLE_EXTENSIONS.get(fileName.slice(dot).toLowerCase()) ?? null)
    : null;
}

/** Every PDF or Word attachment in the message, in the order they come. */
export function listSignableAttachments(
  message: GmailMessage,
  maxSizeBytes = MAX_UPLOAD_SIZE_BYTES,
): SignableAttachment[] {
  const found: SignableAttachment[] = [];
  const stack: GmailMessagePart[] = message.payload ? [message.payload] : [];

  // Depth-first, keeping the parts' own order.
  while (stack.length > 0 && found.length < 20) {
    const part = stack.shift()!;
    const attachmentId = part.body?.attachmentId;
    const fileName = part.filename?.trim() ?? "";

    if (attachmentId && fileName) {
      const mimeType = signableMimeType(part.mimeType ?? "", fileName);
      const sizeBytes = part.body?.size ?? 0;

      if (mimeType) {
        found.push({
          attachmentId,
          fileName,
          mimeType,
          partId: part.partId ?? "",
          sizeBytes,
          tooLarge: sizeBytes > maxSizeBytes,
        });
      }
    }

    stack.unshift(...(part.parts ?? []));
  }

  return found;
}

function header(message: GmailMessage, name: string): string | null {
  const wanted = name.toLowerCase();

  for (const entry of message.payload?.headers ?? []) {
    if (entry.name?.toLowerCase() === wanted && entry.value) {
      return entry.value;
    }
  }

  return null;
}

/** "Name <address>", "<address>" or "address" into its parts. */
export function parseFromHeader(value: string | null): GmailSender | null {
  if (!value) {
    return null;
  }

  const angle = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/.exec(
    value,
  );
  const email = (angle ? angle[2]! : value.trim()).toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }

  const name = angle?.[1]?.trim().replace(/\s+/g, " ") ?? "";

  return { email, name: name && name !== email ? name : null };
}

export function readMessageSummary(message: GmailMessage): {
  sender: GmailSender | null;
  subject: string;
} {
  return {
    sender: parseFromHeader(header(message, "From")),
    subject: header(message, "Subject")?.trim() || "(no subject)",
  };
}

type FetchLike = typeof fetch;

export type GmailTokens = {
  /** The event's gmail.accessToken, for the open message. */
  messageAccessToken: string;
  /** authorizationEventObject.userOAuthToken. */
  userOAuthToken: string;
};

function gmailHeaders(tokens: GmailTokens): HeadersInit {
  return {
    authorization: `Bearer ${tokens.userOAuthToken}`,
    "x-goog-gmail-access-token": tokens.messageAccessToken,
  };
}

async function gmailGet(
  path: string,
  tokens: GmailTokens,
  fetchImpl: FetchLike,
): Promise<unknown> {
  let response: Response;

  try {
    response = await fetchImpl(`${GMAIL_API}${path}`, {
      headers: gmailHeaders(tokens),
    });
  } catch {
    throw new GmailApiError("Gmail could not be reached.", null);
  }

  if (!response.ok) {
    throw new GmailApiError(
      `Gmail answered with ${String(response.status)}.`,
      response.status,
    );
  }

  return response.json();
}

/** The open message's headers and the structure of its parts. */
export async function getOpenMessage(
  messageId: string,
  tokens: GmailTokens,
  fetchImpl: FetchLike = fetch,
): Promise<GmailMessage> {
  return (await gmailGet(
    `/messages/${encodeURIComponent(messageId)}?format=full`,
    tokens,
    fetchImpl,
  )) as GmailMessage;
}

/** One attachment of the open message, as bytes. */
export async function getAttachmentBytes(
  messageId: string,
  attachmentId: string,
  tokens: GmailTokens,
  fetchImpl: FetchLike = fetch,
): Promise<Buffer> {
  const body = (await gmailGet(
    `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    tokens,
    fetchImpl,
  )) as { data?: unknown };

  if (typeof body.data !== "string") {
    throw new GmailApiError("Gmail sent no attachment.", 200);
  }

  // Gmail sends it base64url-encoded.
  return Buffer.from(body.data, "base64url");
}
