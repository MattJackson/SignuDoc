import assert from "node:assert/strict";
import { test } from "node:test";

import { PLANNED_CHANNELS, safeErrorCode } from "./channel.ts";
import {
  listNotificationEvents,
  notificationEventKinds,
  notificationKindFor,
  NOTIFICATION_EVENTS,
} from "./events.ts";
import {
  buildNotificationMessage,
  readNotificationPayload,
  type NotificationEnvelope,
} from "./message.ts";
import {
  MAX_DELIVERY_ATTEMPTS,
  retryDelaySeconds,
  updateForFailure,
} from "./outbox.ts";
import { readNotificationThresholds } from "./settings.ts";

// The channel-independent parts of notifications: the event model, the
// messages, and the retry schedule.

const envelope: NotificationEnvelope = {
  expiresAt: null,
  id: "env-1",
  ownerEmail: "sam@example.com",
  ownerName: "Sam Sender",
  signedCount: 1,
  signerCount: 2,
  status: "sent",
  title: "Master services agreement",
};

test("audit events map to notification kinds, and the rest are dropped", () => {
  assert.equal(notificationKindFor("audit", "sent"), "envelope_sent");
  assert.equal(notificationKindFor("audit", "viewed"), "envelope_viewed");
  assert.equal(notificationKindFor("audit", "signed"), "envelope_signed");
  assert.equal(notificationKindFor("audit", "completed"), "envelope_completed");
  assert.equal(notificationKindFor("audit", "declined"), "envelope_declined");
  assert.equal(notificationKindFor("audit", "voided"), "envelope_voided");
  assert.equal(notificationKindFor("audit", "expired"), "envelope_expired");
  assert.equal(notificationKindFor("audit", "email_sent"), null);
  assert.equal(notificationKindFor("audit", "consented"), null);
  assert.equal(notificationKindFor("audit", "some_future_event"), null);
  assert.equal(notificationKindFor("job", "envelope_stuck"), "envelope_stuck");
  assert.equal(notificationKindFor("job", "backup_failed"), "backup_failed");
  assert.equal(notificationKindFor("job", "signed"), null);
});

test("every kind has a definition, and the job's own kinds come from no audit event", () => {
  assert.equal(listNotificationEvents().length, notificationEventKinds.length);

  for (const kind of notificationEventKinds) {
    assert.equal(NOTIFICATION_EVENTS[kind].kind, kind);
  }

  for (const kind of [
    "envelope_expiring_soon",
    "envelope_stuck",
    "backup_failed",
  ] as const) {
    assert.equal(NOTIFICATION_EVENTS[kind].auditEvent, null);
  }

  assert.equal(NOTIFICATION_EVENTS.backup_failed.audience, "admin");
});

test("a message says what happened, who did it, and links to the envelope", () => {
  const message = buildNotificationMessage({
    appUrl: "https://sign.example.com/",
    envelope,
    kind: "envelope_signed",
    payload: { signerEmail: "riley@example.com", signerName: "Riley" },
  });

  assert.equal(
    message.headline,
    'Riley (riley@example.com) signed "Master services agreement"',
  );
  assert.deepEqual(message.fields, [
    { label: "Status", value: "Out for signature" },
    { label: "Signed", value: "1 of 2" },
    { label: "Sender", value: "Sam Sender (sam@example.com)" },
  ]);
  assert.deepEqual(message.link, {
    label: "Open envelope",
    url: "https://sign.example.com/envelopes/env-1",
  });
  assert.match(message.text, /Master services agreement/);
});

test("each kind has its own headline", () => {
  const headlines = notificationEventKinds.map(
    (kind) =>
      buildNotificationMessage({
        appUrl: null,
        envelope: kind === "backup_failed" ? null : envelope,
        kind,
        payload: { expiresAt: 1_900_000_000, idleDays: 7, signerName: "Riley" },
      }).headline,
  );

  assert.equal(new Set(headlines).size, headlines.length);
  assert.ok(headlines.some((line) => /no activity for 7 days/.test(line)));
  assert.ok(headlines.some((line) => /expires on/.test(line)));
});

test("without the site's address there is no link", () => {
  assert.equal(
    buildNotificationMessage({
      appUrl: null,
      envelope,
      kind: "envelope_completed",
      payload: {},
    }).link,
    null,
  );
  assert.deepEqual(
    buildNotificationMessage({
      appUrl: "https://sign.example.com",
      envelope: null,
      kind: "backup_failed",
      payload: { status: "partial" },
    }).link,
    { label: "Open Settings", url: "https://sign.example.com/settings" },
  );
});

test("a payload keeps who did it and nothing else", () => {
  assert.deepEqual(
    readNotificationPayload({
      declineReason: "Private reason",
      documentText: "secret",
      signerEmail: " riley@example.com ",
      signerName: "Riley",
      idleDays: 7,
      expiresAt: "not a number",
    }),
    { idleDays: 7, signerEmail: "riley@example.com", signerName: "Riley" },
  );
  assert.deepEqual(readNotificationPayload(null), {});
  assert.deepEqual(readNotificationPayload("text"), {});
});

test("retries wait longer each time, up to six hours", () => {
  const none = () => 0;

  assert.equal(retryDelaySeconds(1, none), 60);
  assert.equal(retryDelaySeconds(2, none), 120);
  assert.equal(retryDelaySeconds(3, none), 240);
  assert.equal(retryDelaySeconds(20, none), 6 * 60 * 60);
  // Up to a fifth more, so many failures do not all retry at once.
  assert.equal(
    retryDelaySeconds(1, () => 1),
    72,
  );
});

test("a failure becomes a later attempt, a pause, or the end", () => {
  const now = 1_000_000;
  const none = () => 0;

  assert.deepEqual(
    updateForFailure(
      { error: "internal_error", outcome: "retry", retryAfterSeconds: null },
      1,
      now,
      none,
    ),
    {
      countAttempt: true,
      error: "internal_error",
      nextAttemptAt: now + 60,
      status: "pending",
    },
  );
  // Slack's own Retry-After wins when it is longer than the backoff.
  assert.deepEqual(
    updateForFailure(
      { error: "http_503", outcome: "retry", retryAfterSeconds: 600 },
      1,
      now,
      none,
    ),
    {
      countAttempt: true,
      error: "http_503",
      nextAttemptAt: now + 600,
      status: "pending",
    },
  );
  // A rate limit is a pause, not a failed attempt.
  assert.deepEqual(
    updateForFailure(
      { error: "ratelimited", outcome: "rate_limited", retryAfterSeconds: 30 },
      MAX_DELIVERY_ATTEMPTS,
      now,
      none,
    ),
    {
      countAttempt: false,
      error: "ratelimited",
      nextAttemptAt: now + 30,
      status: "pending",
    },
  );
  assert.deepEqual(
    updateForFailure(
      { error: "channel_not_found", outcome: "failed" },
      1,
      now,
      none,
    ),
    { error: "channel_not_found", status: "failed" },
  );
  assert.deepEqual(
    updateForFailure(
      { error: "invalid_auth", outcome: "auth" },
      MAX_DELIVERY_ATTEMPTS,
      now,
      none,
    ),
    { error: "invalid_auth", status: "failed" },
  );
  assert.equal(
    updateForFailure({ error: "invalid_auth", outcome: "auth" }, 2, now, none)
      .status,
    "pending",
  );
});

test("thresholds come from the environment, then settings, then defaults", () => {
  assert.deepEqual(readNotificationThresholds({}, {}), {
    expiringDays: 3,
    expiringFromEnv: false,
    stuckDays: 7,
    stuckFromEnv: false,
  });
  assert.deepEqual(
    readNotificationThresholds(
      { NOTIFICATION_STUCK_DAYS: "0" },
      { "notifications.expiringDays": "5", "notifications.stuckDays": "10" },
    ),
    {
      expiringDays: 5,
      expiringFromEnv: false,
      stuckDays: 0,
      stuckFromEnv: true,
    },
  );
  assert.equal(
    readNotificationThresholds({}, { "notifications.stuckDays": "999" })
      .stuckDays,
    60,
  );
});

test("error codes are kept short and plain", () => {
  assert.equal(safeErrorCode("channel_not_found"), "channel_not_found");
  assert.equal(safeErrorCode("has spaces"), "unknown_error");
  assert.equal(safeErrorCode(42), "unknown_error");
  assert.equal(safeErrorCode("x".repeat(81)), "unknown_error");
});

test("the channels to come are listed, and Slack is not among them", () => {
  assert.deepEqual(
    PLANNED_CHANNELS.map((channel) => channel.id),
    ["google_chat", "teams", "webhook"],
  );
});
