# Notifications

SignuDoc can tell people in a chat tool when something happens to an envelope, and tell administrators when something needs their attention. Slack is the first channel. Google Chat, Microsoft Teams and plain webhooks are listed on the setup page as coming later.

Nothing is sent until an administrator sets a channel up, and email works as before whatever is set here.

## What is announced

| Event              | When                                                                | Direct message by default |
| ------------------ | ------------------------------------------------------------------- | ------------------------- |
| Sent               | An envelope was sent for signature.                                 | No                        |
| Opened             | A signer opened it for the first time.                              | No                        |
| Signed             | A signer signed (one message per signer).                           | Yes                       |
| Approved           | An approver approved (one message per approver).                    | Yes                       |
| Rejected           | An approver rejected it, which ends the envelope.                   | Yes                       |
| Completed          | Everyone has signed and the signed PDF is ready.                    | Yes                       |
| Declined           | A signer declined.                                                  | Yes                       |
| Voided             | The sender withdrew it.                                             | No                        |
| Expired            | The deadline passed before everyone signed.                         | Yes                       |
| Deadline coming up | The deadline is a few days away (3 by default).                     | Yes                       |
| No activity        | Nobody has opened or signed it for a number of days (7 by default). | Yes                       |
| Backup failed      | The daily backup failed or left files out. Administrators only.     | Yes                       |

A message names the envelope by its title, says what happened and who did it (a signer's name and address), where the envelope stands (status, how many have signed, the sender, the deadline), and has a button that opens the envelope here. It never carries the document, a field's value or a decline reason: whoever can read the channel is sent to SignuDoc, which checks who they are, for anything more.

"Deadline coming up" is sent once per deadline (moving the deadline and coming close again sends it again), and "No activity" once per envelope. Activity is anything in the envelope's audit trail except the emails and reminders SignuDoc itself sent. Only envelopes sent in the last 90 days are checked for activity, so turning notifications on does not announce every forgotten envelope.

## Who gets what

- **The sender** of an envelope gets a direct message for the events marked "Yes" above. Each person changes that for themselves under Settings, Notifications, My notifications.
- **Teammates** (people on a team with the sender) get nothing about each other's envelopes unless they turn an event on for "My teams' envelopes". A draft is never announced to anyone but its sender.
- **Administrators** get "Backup failed" unless they turn it off.
- **Channels** get what a rule sends them. A rule names the events, one Slack channel, and either every envelope or one team's. A team's rule only takes envelopes sent by members of that team, so the sales team's channel never hears about anyone else's envelopes; and it never takes the install's own events, such as a failed backup.

Slack finds a person by the email address of their account here (`users.lookupByEmail`), so their Slack account needs the same address. A person Slack cannot find is skipped, which the setup page counts.

## Set up Slack

Under Settings, Notifications (also a step of onboarding):

1. **Create the app.** Open [api.slack.com/apps](https://api.slack.com/apps?new_app=1), choose From a manifest, pick your workspace, and paste the manifest the page shows. It is filled in with your organization's name and this site's address.
2. **Install it and paste the token.** Under Install App, install it to your workspace and copy the Bot User OAuth Token (`xoxb-...`) into the page. It is stored encrypted, like the other secrets in Settings, and never shown again. `SLACK_BOT_TOKEN`, when set, wins and the page shows the token as fixed.
3. **Test the connection.** The page asks Slack (`auth.test`) which workspace the token belongs to.
4. **Direct messages** are on once the token is saved. Turn them off to only post to channels. "Send me a test message" checks that Slack finds you.
5. **Invite the app to each channel** that should get posts (`/invite @AppName` in the channel), then add a rule for it. The page lists public channels to pick from; for a private channel, invite the app and paste the channel's ID from its details.

### Why these scopes

The manifest asks for four bot scopes and nothing else:

| Scope              | Why                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat:write`       | Post the messages, to people and to channels the app was invited to. Without `chat:write.public` it cannot post anywhere it was not invited. |
| `users:read`       | Needed with `users:read.email`; Slack does not grant one without the other.                                                                  |
| `users:read.email` | Find a person by their email address, for direct messages.                                                                                   |
| `channels:read`    | List public channels to pick from when making a rule. Private channels are pasted by ID instead, so `groups:read` is not needed.             |

The app has no event subscriptions, slash commands or interactivity, and cannot read messages. The button in a message is a plain link.

## How delivery works

1. Every envelope audit event is queued in `notification_events` by a database trigger, in the audit event's own transaction. So an event that is recorded is never missed, and one that is rolled back is never announced. The notifications job queues its own events (deadlines, idle envelopes, failed backups) the same way, each under a key that makes it happen once.
2. Right after a request that recorded an audit event, the app turns queued events into deliveries (`notification_deliveries`, one per person or channel, unique, so never two to the same place) and sends them. On Vercel this runs in `after()`, once the response has gone.
3. A failed send is tried again 1, 2, 4... minutes later, up to six hours apart, eight times in all. When Slack asks to slow down (HTTP 429), its `Retry-After` is kept and nothing more goes to Slack until it has passed; that does not count as a try. A channel that does not exist, or that the app was never invited to, fails at once. Only Slack's HTTP status and error code are kept, never what else it sent back.
4. `/api/internal/notifications` runs the whole job: it notices deadlines, idle envelopes and failed backups, and sends whatever is due, retries included. See [Notifications](self-hosting.md#notifications) in the self-hosting guide for scheduling it.

Delivery is at least once: a run cut off between Slack taking a message and the app noting it sends that message again later. Events older than three days that were never processed (notifications switched off, say) are dropped rather than announced late. Processed events are deleted after 30 days.

## Settings and environment variables

| Setting                | In Settings, Notifications              | Environment variable (wins)  |
| ---------------------- | --------------------------------------- | ---------------------------- |
| Slack bot token        | Bot User OAuth Token                    | `SLACK_BOT_TOKEN`            |
| Direct messages        | Send direct messages                    | none                         |
| Deadline warning, days | Days before a deadline (0 turns it off) | `NOTIFICATION_EXPIRING_DAYS` |
| Idle warning, days     | Days without activity (0 turns it off)  | `NOTIFICATION_STUCK_DAYS`    |

Every change of these settings and of the rules is recorded in the install's audit trail.

## Adding a channel

A channel is an implementation of `NotificationChannel` (`src/lib/notifications/channel.ts`): how it says whether it is set up, how it finds a person by email, and how it sends a message to an address. Add it to `registry.ts` and give it a setup section on the page; the outbox, the rules and everyone's choices already work for any channel by its id.

## Adding an event

Add the kind to `notificationEventKinds` and `NOTIFICATION_EVENTS` in `src/lib/notifications/events.ts`, with the audit event it comes from, and its headline in `message.ts`. A new kind of envelope audit event is already queued by the trigger; no migration is needed. The pages, the rules and the choices list whatever is in `events.ts`.
