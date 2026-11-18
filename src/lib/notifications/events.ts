// The things a notification can be about, and where each one comes from.
//
// Most come from an envelope's audit trail: a database trigger queues every
// audit event (see db/migrations/20261209090000_notifications.sql) and the
// event's `auditEvent` below says which kind of notification it becomes.
// An audit event with no kind here is dropped. The rest are noticed by the
// notifications job: a deadline coming up, an envelope nobody has touched
// for a while, a backup that failed.
//
// To announce a new kind of audit event, add
// it to notificationEventKinds and NOTIFICATION_EVENTS with its
// `auditEvent`, a headline and tone in message.ts, and an emoji in
// slack/layout.ts. Nothing else changes: rules,
// preferences and the pages list whatever is here.

export const notificationEventKinds = [
  "envelope_sent",
  "envelope_viewed",
  "envelope_signed",
  "envelope_approved",
  "envelope_rejected",
  "envelope_completed",
  "envelope_declined",
  "envelope_voided",
  "envelope_expired",
  "envelope_expiring_soon",
  "envelope_stuck",
  "backup_failed",
] as const;

export type NotificationEventKind = (typeof notificationEventKinds)[number];

/**
 * "envelope": about one envelope, for its sender, their teammates and
 * channels. "admin": about the install, for administrators and channels
 * that take every envelope (never a team's channel).
 */
export type NotificationAudience = "admin" | "envelope";

export type NotificationEventDefinition = {
  audience: NotificationAudience;
  /** The envelope audit event this comes from, when it comes from one. */
  auditEvent: string | null;
  description: string;
  kind: NotificationEventKind;
  label: string;
  /** Whether the sender (or, for "admin", each administrator) gets a direct message unless they turn it off. */
  onByDefault: boolean;
};

export const NOTIFICATION_EVENTS: Record<
  NotificationEventKind,
  NotificationEventDefinition
> = {
  envelope_approved: {
    audience: "envelope",
    auditEvent: "approved",
    description:
      "An approver approved the document (one message per approver).",
    kind: "envelope_approved",
    label: "Approved",
    onByDefault: true,
  },
  envelope_rejected: {
    audience: "envelope",
    auditEvent: "rejected",
    description: "An approver rejected the document, which ends the envelope.",
    kind: "envelope_rejected",
    label: "Rejected",
    onByDefault: true,
  },
  backup_failed: {
    audience: "admin",
    auditEvent: null,
    description: "The daily backup failed or left files out.",
    kind: "backup_failed",
    label: "Backup failed",
    onByDefault: true,
  },
  envelope_completed: {
    audience: "envelope",
    auditEvent: "completed",
    description: "Everyone has signed and the signed PDF is ready.",
    kind: "envelope_completed",
    label: "Completed",
    onByDefault: true,
  },
  envelope_declined: {
    audience: "envelope",
    auditEvent: "declined",
    description: "A signer declined to sign.",
    kind: "envelope_declined",
    label: "Declined",
    onByDefault: true,
  },
  envelope_expired: {
    audience: "envelope",
    auditEvent: "expired",
    description: "The deadline passed before everyone signed.",
    kind: "envelope_expired",
    label: "Expired",
    onByDefault: true,
  },
  envelope_expiring_soon: {
    audience: "envelope",
    auditEvent: null,
    description: "The deadline is a few days away and signatures are missing.",
    kind: "envelope_expiring_soon",
    label: "Deadline coming up",
    onByDefault: true,
  },
  envelope_sent: {
    audience: "envelope",
    auditEvent: "sent",
    description: "An envelope was sent for signature.",
    kind: "envelope_sent",
    label: "Sent",
    onByDefault: false,
  },
  envelope_signed: {
    audience: "envelope",
    auditEvent: "signed",
    description: "A signer signed (one message per signer).",
    kind: "envelope_signed",
    label: "Signed",
    onByDefault: true,
  },
  envelope_stuck: {
    audience: "envelope",
    auditEvent: null,
    description: "Nobody has opened or signed it for a number of days.",
    kind: "envelope_stuck",
    label: "No activity",
    onByDefault: true,
  },
  envelope_viewed: {
    audience: "envelope",
    auditEvent: "viewed",
    description: "A signer opened the envelope for the first time.",
    kind: "envelope_viewed",
    label: "Opened",
    onByDefault: false,
  },
  envelope_voided: {
    audience: "envelope",
    auditEvent: "voided",
    description: "The sender withdrew the envelope.",
    kind: "envelope_voided",
    label: "Voided",
    onByDefault: false,
  },
};

export function isNotificationEventKind(
  value: unknown,
): value is NotificationEventKind {
  return (
    typeof value === "string" &&
    (notificationEventKinds as readonly string[]).includes(value)
  );
}

const kindsByAuditEvent = new Map(
  Object.values(NOTIFICATION_EVENTS)
    .filter((definition) => definition.auditEvent !== null)
    .map((definition) => [definition.auditEvent as string, definition.kind]),
);

/**
 * The kind a queued event is. An audit event is looked up by its name; an
 * event the job queued is already named by its kind. Null: not announced.
 */
export function notificationKindFor(
  source: "audit" | "job",
  event: string,
): NotificationEventKind | null {
  if (source === "audit") {
    return kindsByAuditEvent.get(event) ?? null;
  }

  return isNotificationEventKind(event) ? event : null;
}

/**
 * Progress on an envelope. In a person's direct messages these edit one
 * message per envelope instead of posting a new one each time; the rest
 * (outcomes, and warnings that need someone to act) post a new message.
 */
export const IN_PLACE_KINDS: ReadonlySet<NotificationEventKind> = new Set([
  "envelope_sent",
  "envelope_viewed",
  "envelope_signed",
  "envelope_approved",
  "envelope_voided",
]);

/**
 * Events that come in bursts (several signers in a row). Their messages
 * wait a minute, and only the newest of a burst for the same place is
 * sent: every message shows the envelope as it is when sent, so the newest
 * covers the rest.
 */
export const BURST_KINDS: ReadonlySet<NotificationEventKind> = new Set([
  "envelope_viewed",
  "envelope_signed",
  "envelope_approved",
]);

/** How long a burst event waits for the next one. */
export const BURST_HOLD_SECONDS = 60;

/** Events a person caused themselves, so they never hear about them. */
export const SELF_ACTION_KINDS: ReadonlySet<NotificationEventKind> = new Set([
  "envelope_sent",
  "envelope_viewed",
  "envelope_signed",
  "envelope_approved",
  "envelope_rejected",
  "envelope_declined",
  "envelope_voided",
]);

/** The kinds in the order the pages list them. */
export function listNotificationEvents(): NotificationEventDefinition[] {
  return notificationEventKinds.map((kind) => NOTIFICATION_EVENTS[kind]);
}
