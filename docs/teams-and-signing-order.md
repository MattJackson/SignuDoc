# Teams and signing order

How signers can sign at the same time, and how people on a team see each other's envelopes.

- [Signing order](#signing-order)
- [Approvers](#approvers)
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

## Approvers

Anyone in the signing order can be an **approver** instead of a signer. On the signers page, each person has **Signs the document** or **Approves or rejects it (no fields)**.

- An approver **reviews the document and approves or rejects it**. They have no fields, place no signature, and nothing of theirs is stamped on the signed PDF. They see what the steps before them filled in, as a signer does.
- Approvers are **in the steps like signers**. The next step starts once every signer and approver of the step before is done. So a salesperson can have their manager approve first, and the customer sign once the manager has:

| Person          | Role     | Step |
| --------------- | -------- | ---- |
| Sales manager   | Approver | 1    |
| Customer        | Signer   | 2    |
| Company officer | Signer   | 3    |

- **Reject** works like decline: it ends the envelope for everyone, with the reason the approver gives, and the sender is emailed "was rejected by".
- An approver goes through the same checks as a signer: the access code or emailed code the sender asked for, and the agreement to use electronic records.
- An envelope needs at least one signer. Approvers cannot have fields: placing fields offers only the signers, and saving a field for an approver is refused (by the app and by the database).

**Add my manager.** With the [Workspace directory](google-workspace.md#2-the-workspace-directory) on, the signers page has **Add my manager to approve**. It looks up the sender's manager (the "manager" in their directory entry) and puts them first, as an approver in a step of their own. If the directory names no manager, or the manager's account is suspended, the page says so. An administrator can suggest or require this; see [The sender's manager](google-workspace.md#5-the-senders-manager).

**Templates.** A template keeps whether each role signs or approves. When saving one, a role can be marked **Sender's manager**: using the template then fills that role with the manager of whoever uses it, looked up in the directory at that moment. If it cannot be found, the template is not used, and the message says why.

### What happens along the way

- **Invitations and reminders** ask an approver to "review and approve or reject", not to sign.
- **Deadlines, reminders, void and correcting a person** work for approvers exactly as for signers.
- **Audit trail.** An approval is recorded as **approved** and a rejection as **rejected**, never as signed or declined, with the approver's step and the checks they passed. The envelope's timeline says "Approved by" and "Rejected by".
- **Certificate.** The list is headed "Signers and approvers", each approver is marked **Approver** with "Approved at" or "Rejected at", and a separate **Approvals** section lists "Approved by" (or "Rejected by", with the reason) for each approver. A line says approvers placed no signature.
- **At the same moment.** An approval takes hold of the envelope's row exactly as a signature does, so an approver and a signer of one step who finish at the same moment move the order on, or finish the envelope, once. `src/lib/approvers.dbtest.ts` runs these races.

### Where approvers are not offered

- **Part 11 mode.** An approval is an electronic signature under 21 CFR Part 11 (11.50 lists approval as a meaning), with the account, password and printed manifestation that go with one. Part 11 mode therefore has no approvers: add the person as a signer with the meaning Approval. The signers page does not offer the choice, a send with approvers is refused, and an approval on a Part 11 envelope is refused too. See [Known gaps](part11/known-gaps.md).
- **Advanced and qualified signatures.** The finished document is the last signer's own signed revision, and an approval makes none. Send with SignuDoc signatures, or make the approver a signer.

### Upgrading

The migration `20261207090000_approvers.sql` allows the role `approver` and the events `approved`, `rejected` and `handed_over`. An approval is stored as the person's turn being done (`signers.status = 'signed'`, with `signed_at` the time of the approval) and a rejection as `declined`, so everything that moves the order on, counts who is still to act or locks a turn treats an approver exactly as a signer; the role and the events tell them apart. An older version of the app reads only role `signer` and would leave approvers out of the signing order, so roll back past this migration only with no approvers on envelopes out for signature.

## Teams

An administrator makes teams under **Settings, Teams**, and adds people who have an account by their email address. Someone can be on several teams.

People on a team see the envelopes sent by the others on any of their teams. The dashboard has **Mine** and **My team**, and an administrator also has **Everyone's**. A teammate's envelope says who sent it.

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
| Schedule a finished envelope for deletion (14 days), or cancel that                  | if admin   | no                                | yes              | no          |

Administrators see every sent envelope, read-only, and an administrator's download of someone else's file is recorded in the site audit trail. An envelope handed to an administrator when its sender's account was closed is that administrator's, so the closed account's teammates see it only if they are on a team with that administrator. The same holds for an envelope handed to someone's manager when the Workspace directory said they had left ([Offboarding](google-workspace.md#4-offboarding)): it is the manager's from then on.

Envelope pages and downloads that are not someone's to see answer "not found", the same as for an envelope that does not exist.

## For developers

- `src/lib/signing-steps.ts`: steps, renumbering, and who is invited next.
- `src/lib/signing.ts`: `submitSigningForToken`, `approveSigningForToken` (the same path, with no fields and an "approved" event) and `declineSigningForToken` (a "rejected" event for an approver), and the restart when the route changed (`SigningRouteChangedError`).
- `src/lib/manager-policy.ts`: the sender's manager from the directory, and the administrator's rule.
- `src/lib/envelope-access.ts`: the one rule for who can read an envelope. Everything that changes an envelope still checks `user_id` itself.
- `src/lib/teams.ts` and `src/app/api/admin/teams/`: teams and their audit events.
- Tests: `signing-steps.test.ts`, `parallel-signing.dbtest.ts`, `approvers.dbtest.ts`, `manager-policy.test.ts`, `manager-policy.dbtest.ts` and `team-access.dbtest.ts`, which goes through the table above.
