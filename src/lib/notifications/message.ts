import { NOTIFICATION_EVENTS, type NotificationEventKind } from "./events.ts";

// What a notification says, before any one chat tool lays it out. It names
// the envelope by its title, says what happened and who did it, where the
// envelope stands, and links to it in this app. Nothing from the document
// itself and no decline reason is ever in it: whoever can read the channel
// is sent to the app, which checks who they are, for anything more.

export type NotificationEnvelope = {
  expiresAt: number | null;
  id: string;
  ownerEmail: string;
  ownerName: string;
  signedCount: number;
  signerCount: number;
  status: string;
  title: string;
};

/** Who did it, from the queued event. Never anything else. */
export type NotificationPayload = {
  actorEmail?: string;
  expiresAt?: number;
  idleDays?: number;
  signerEmail?: string;
  signerName?: string;
  status?: string;
};

export type NotificationMessage = {
  /** Short facts shown under the headline. */
  fields: { label: string; value: string }[];
  /** One sentence: what happened. Plain text, unescaped. */
  headline: string;
  kind: NotificationEventKind;
  link: { label: string; url: string } | null;
  /** Everything in one line, for notifications and tools without layout. */
  text: string;
};

const STATUS_LABELS: Record<string, string> = {
  completed: "Completed",
  declined: "Declined",
  draft: "Draft",
  sent: "Out for signature",
  voided: "Voided",
};

function person(name: string | undefined, email: string | undefined): string {
  const trimmedName = name?.trim();
  const trimmedEmail = email?.trim();

  if (trimmedName && trimmedEmail) {
    return `${trimmedName} (${trimmedEmail})`;
  }

  return trimmedName || trimmedEmail || "A signer";
}

function formatDate(unixSeconds: number): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(unixSeconds * 1000));
}

function quoted(title: string): string {
  return `"${title}"`;
}

function headlineFor(
  kind: NotificationEventKind,
  envelope: NotificationEnvelope | null,
  payload: NotificationPayload,
): string {
  const title = envelope ? quoted(envelope.title) : "An envelope";
  const signer = person(payload.signerName, payload.signerEmail);

  switch (kind) {
    case "envelope_sent":
      return `${envelope?.ownerName || envelope?.ownerEmail || "Someone"} sent ${title} for signature`;
    case "envelope_viewed":
      return `${signer} opened ${title}`;
    case "envelope_signed":
      return `${signer} signed ${title}`;
    case "envelope_completed":
      return `${title} is complete: everyone has signed`;
    case "envelope_declined":
      return `${signer} declined to sign ${title}`;
    case "envelope_voided":
      return `${title} was voided`;
    case "envelope_expired":
      return `${title} expired before everyone signed`;
    case "envelope_expiring_soon": {
      const at = payload.expiresAt ?? envelope?.expiresAt ?? null;

      return at === null
        ? `${title} expires soon`
        : `${title} expires on ${formatDate(at)}`;
    }
    case "envelope_stuck":
      return payload.idleDays
        ? `${title} has had no activity for ${String(payload.idleDays)} days`
        : `${title} has had no activity for a while`;
    case "backup_failed":
      return payload.status === "partial"
        ? "The backup finished, but some files could not be copied"
        : "The backup failed";
  }
}

/**
 * The message for one event. `envelope` is null for the install's own
 * events. `appUrl` is this site's address, without which there is no link.
 */
export function buildNotificationMessage({
  appUrl,
  envelope,
  kind,
  payload,
}: {
  appUrl: string | null;
  envelope: NotificationEnvelope | null;
  kind: NotificationEventKind;
  payload: NotificationPayload;
}): NotificationMessage {
  const headline = headlineFor(kind, envelope, payload);
  const base = appUrl?.replace(/\/+$/, "") ?? null;
  const fields: NotificationMessage["fields"] = [];
  let link: NotificationMessage["link"] = null;

  if (envelope) {
    fields.push({
      label: "Status",
      value: STATUS_LABELS[envelope.status] ?? envelope.status,
    });

    if (envelope.signerCount > 0) {
      fields.push({
        label: "Signed",
        value: `${String(envelope.signedCount)} of ${String(envelope.signerCount)}`,
      });
    }

    fields.push({
      label: "Sender",
      value: envelope.ownerName
        ? `${envelope.ownerName} (${envelope.ownerEmail})`
        : envelope.ownerEmail,
    });

    if (envelope.expiresAt !== null && envelope.status === "sent") {
      fields.push({ label: "Deadline", value: formatDate(envelope.expiresAt) });
    }

    if (base) {
      link = {
        label: "Open envelope",
        url: `${base}/envelopes/${encodeURIComponent(envelope.id)}`,
      };
    }
  } else if (base && NOTIFICATION_EVENTS[kind].audience === "admin") {
    link = { label: "Open Settings", url: `${base}/settings` };
  }

  const text = [
    headline,
    ...fields.map((field) => `${field.label}: ${field.value}`),
    link?.url,
  ]
    .filter(Boolean)
    .join(" · ");

  return { fields, headline, kind, link, text };
}

/** Reads a queued event's payload, keeping only the fields it may hold. */
export function readNotificationPayload(raw: unknown): NotificationPayload {
  if (typeof raw !== "object" || raw === null) {
    return {};
  }

  const value = raw as Record<string, unknown>;
  const payload: NotificationPayload = {};

  for (const key of [
    "actorEmail",
    "signerEmail",
    "signerName",
    "status",
  ] as const) {
    const field = value[key];

    if (typeof field === "string" && field.trim()) {
      payload[key] = field.trim().slice(0, 320);
    }
  }

  for (const key of ["expiresAt", "idleDays"] as const) {
    const field = value[key];

    if (typeof field === "number" && Number.isFinite(field)) {
      payload[key] = field;
    }
  }

  return payload;
}
