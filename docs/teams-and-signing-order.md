# Teams and signing order

How signers can sign at the same time, and how people on a team see each other's envelopes.

- [Signing order](#signing-order)
- [Teams](#teams)
- [Who can do what](#who-can-do-what)
- [For developers](#for-developers)

## Signing order

The signing order is a list of steps. Each signer is in one step.

- Signers in **the same step sign at the same time.** They are all invited when the step starts, each with a link of their own, and sign in any order among themselves.
- **The next step starts once every signer of the step before has signed.** Its signers are invited then.
- A list where every signer has a step of their own is the plain one-after-the-other order, which is what every envelope sent before steps existed has.
- **Copy recipients** are not in any step. They get the finished document once everyone has signed, as before.

On the signers page, each signer after the first has **Sign at the same time as Signer N**. Ticked, they join the step of the signer above them. So a salesperson can send a contract to the customer and their manager at the same time, and to the company's signatory once both have signed:

| Signer          | Sign at the same time as the signer above | Step |
| --------------- | ----------------------------------------- | ---- |
| Customer        |                                           | 1    |
| Sales manager   | ticked                                    | 1    |
| Company officer |                                           | 2    |

A template keeps each role's step, so roles that signed at the same time still do when the template is used. A template saved before steps existed signs one role after the other.

### What happens along the way

- **Invitations.** Sending invites everyone in the first step. If the first invitation cannot be sent, nothing is sent and the envelope stays a draft. Once one has gone out, the envelope is out for signature; a later one that fails is logged, and a reminder sends that signer a new link.
- **Reminders.** The sender's **Send reminder** reminds every signer whose turn it is, each with a new link, leaving out anyone reminded in the last 24 hours. Automatic reminders reach each waiting signer on their own schedule.
- **Deadline.** One deadline for the whole envelope, as before. Changing it moves the links of everyone whose turn it is.
- **Decline.** One signer declining ends the envelope for everyone, including the others in the same step, as before.
- **Void.** Voiding tells everyone whose turn it was.
- **Correcting a signer** works on each waiting signer separately: the corrected person gets a new invitation and the old link stops working.
- **Certificate and audit trail.** The certificate numbers each signer by their step. When some share a step it says that signers with the same number were asked to sign at the same time. The envelope's audit trail records the step of each signature and decline, and the "sent" event names everyone invited at once.

### When two signers submit at the same moment

Every signature takes hold of the envelope's row in the database before it changes anything, and so does every decline, void, reminder and change of deadline. Two signers of one step who submit at the same moment therefore take turns:

- the first one's signature is saved;
- the second one then sees, with the envelope held, whether anyone is still to sign. If someone is, it saves its signature and invites the next step if this one is now done. If nobody is, it starts again as the last signature, and makes the final signed PDF, the certificates and the "completed" event, once.

A decline or a void that finds a signer of the step signed in the meantime starts again too, so its certificate shows that signature. `src/lib/parallel-signing.dbtest.ts` runs these races against a real Postgres.

### Where signing at the same time is not offered

- **Part 11 mode.** Part 11 envelopes are signed one signer after another. The Part 11 validation (requirement SYS-08 and OQ-06) is written for that order, and a different sequence would need your OQ to be run again before use. The signers page does not offer the choice in Part 11 mode, and a send that has signers sharing a step is refused.
- **Advanced and qualified signatures** (eID Easy or a CSC provider). Each such signature is added to the PDF on top of the one before it, so two cannot be made at once. The review page and the send refuse it; choose SignuDoc signatures, or give each signer their own step.

### How many signers

An envelope can have up to 25 signers. Set `MAX_SIGNERS_PER_ENVELOPE` (1 to 100) to change that. The old limit of ten was not tied to anything technical: the certificate runs onto as many pages as it needs. Templates follow the same limit when they are used.

### Upgrading and rolling back

The migration `20261203004000_signing_steps.sql` adds `signers.signing_step` and gives every existing signer the step of their place in the list, so existing envelopes keep signing one after the other. It drops the index that allowed only one waiting signer per envelope. `sign_order` stays the signer's place in the list and stays unique.

An older version of the app still runs on the migrated database, but it signs an envelope whose signers share a step one after the other, and invites only the first of them when it is sent. Roll back past this migration only with no such envelopes out for signature.

## Teams

An administrator makes teams under **Settings, Teams**, and adds people who have an account by their email address. Someone can be on several teams.

People on a team see the envelopes sent by the others on any of their teams. The dashboard has **Mine** and **My team**, and an administrator also has **All**. A teammate's envelope says who sent it.

A team can name a **Google Group**. Nothing reads it yet: it is kept for a later sync of the team's members from that group.

Making, renaming and deleting a team, and adding and removing people, are recorded in the install's audit trail (Settings, Security) as "Team made", "Team changed", "Team deleted", "Added to a team" and "Removed from a team". Deleting a team leaves everyone's envelopes as they are.

## Who can do what

|                                                                                      | The sender | Someone on a team with the sender | An administrator | Anyone else |
| ------------------------------------------------------------------------------------ | ---------- | --------------------------------- | ---------------- | ----------- |
| See a draft                                                                          | yes        | no                                | no               | no          |
| See a sent envelope: its signers, status and timeline                                | yes        | yes                               | yes              | no          |
| Export its audit trail                                                               | yes        | yes                               | yes              | no          |
| Download the signed PDF and certificate once finished                                | yes        | yes                               | yes              | no          |
| Edit a draft, send, remind, change the deadline or reminders, correct a signer, void | yes        | no                                | no               | no          |
| Copy to a new draft, save as a template                                              | yes        | no                                | no               | no          |
| Delete a finished envelope                                                           | if admin   | no                                | only their own   | no          |

Administrators could not see other people's envelopes before teams; they now see every sent one, read-only. An envelope handed to an administrator when its sender's account was closed is that administrator's, so the closed account's teammates see it only if they are on a team with that administrator.

Envelope pages and downloads that are not someone's to see answer "not found", the same as for an envelope that does not exist.

## For developers

- `src/lib/signing-steps.ts`: steps, renumbering, and who is invited next.
- `src/lib/signing.ts`: `submitSigningForToken` and `declineSigningForToken`, and the restart when the route changed (`SigningRouteChangedError`).
- `src/lib/envelope-access.ts`: the one rule for who can read an envelope. Everything that changes an envelope still checks `user_id` itself.
- `src/lib/teams.ts` and `src/app/api/admin/teams/`: teams and their audit events.
- Tests: `signing-steps.test.ts`, `parallel-signing.dbtest.ts` and `team-access.dbtest.ts`, which goes through the table above.
