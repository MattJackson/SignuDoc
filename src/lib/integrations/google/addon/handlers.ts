import {
  EnvelopeMutationError,
  replaceDraftEnvelopeSigners,
} from "../../../envelopes.ts";
import {
  ReminderMutationError,
  sendManualEnvelopeNudge,
} from "../../../reminders.ts";
import { consumeRateLimit } from "../../../security/rate-limit.ts";
import { DocumentImportError } from "../../../services/document-import.ts";
import {
  convertToPdf,
  DocumentConversionError,
  exportGoogleFileToPdf,
} from "../convert.ts";
import {
  createDraftFromDocument,
  ImportDraftAccountError,
} from "../import-draft.ts";
import {
  draftCreatedCard,
  driveItemsCard,
  gmailMessageCard,
  homepageCard,
  messageCard,
  notify,
  pushCard,
  requestFileScope,
  type DriveCardItem,
  type RenderActions,
  type SiteLinks,
} from "./cards.ts";
import type { AddonTrigger } from "./config.ts";
import {
  listContractsFromDriveFile,
  listContractsWithEmail,
  recordEnvelopeSource,
} from "./contracts.ts";
import {
  DriveApiError,
  downloadDriveFile,
  driveFileKind,
  getDriveFileMetadata,
} from "./drive.ts";
import type { AddonEvent } from "./event.ts";
import {
  getAttachmentBytes,
  getOpenMessage,
  GmailApiError,
  listSignableAttachments,
  readMessageSummary,
  type GmailSender,
  type GmailTokens,
} from "./gmail.ts";
import type { AddonUser } from "./users.ts";

// What each of the add-on's endpoints does, once the route has checked
// that Google sent the request and found the person's account
// (app/api/google/addon/[trigger]/route.ts). Every call to Google here is
// made as that person, with the tokens Google put in the event: nothing is
// read with the site's own service account.
//
// - homepage: a short card for Gmail or Drive with nothing open.
// - gmail-message: the open email's PDF and Word attachments, and the
//   envelopes the person can see that involve its sender.
// - drive-items: for each selected file, a way to send it (after asking
//   for the file if the add-on has not been given it) and the envelopes
//   made from it.
// - action: the buttons on those cards: send an attachment or a file for
//   signature, ask for a file, or nudge a signer.
//
// A document sent from here becomes a draft (import-draft.ts), with its
// source noted on the envelope; the person places the fields and sends it
// in SignuDoc, from the link on the card.

export type AddonHandlerContext = {
  event: AddonEvent;
  links: SiteLinks;
  /** For log lines; never shown to the person. */
  log: (message: string, error: unknown) => void;
  user: AddonUser;
};

export async function handleAddonTrigger(
  trigger: AddonTrigger,
  context: AddonHandlerContext,
): Promise<RenderActions> {
  switch (trigger) {
    case "homepage":
      return pushCard(
        homepageCard(context.links.siteUrl, context.event.hostApp),
      );
    case "gmail-message":
      return showGmailMessage(context);
    case "drive-items":
      return showDriveItems(context);
    case "action":
      return runAction(context);
  }
}

function gmailTokens(event: AddonEvent): GmailTokens | null {
  if (!event.gmail || !event.userOAuthToken) {
    return null;
  }

  return {
    messageAccessToken: event.gmail.accessToken,
    userOAuthToken: event.userOAuthToken,
  };
}

function describeGoogleFailure(error: unknown): string {
  const status =
    error instanceof GmailApiError || error instanceof DriveApiError
      ? error.status
      : null;

  if (status === 401 || status === 403) {
    return "Google did not let SignuDoc read it. Close the panel and open it again.";
  }

  if (status === 404) {
    return "Google could not find it any more.";
  }

  if (status === 413) {
    return "The document is larger than 20 MB, the most SignuDoc takes.";
  }

  return "Google could not be reached just now. Try again in a moment.";
}

async function showGmailMessage(context: AddonHandlerContext) {
  const { event, links, user } = context;
  const tokens = gmailTokens(event);

  if (!tokens || !event.gmail) {
    return pushCard(homepageCard(links.siteUrl, "gmail"));
  }

  let message;

  try {
    message = await getOpenMessage(event.gmail.messageId, tokens);
  } catch (error) {
    context.log("Reading the open Gmail message failed.", error);
    return pushCard(
      messageCard("Could not read this email", describeGoogleFailure(error)),
    );
  }

  const { sender, subject } = readMessageSummary(message);
  const contracts =
    sender && sender.email !== user.email.toLowerCase()
      ? await listContractsWithEmail(user.id, sender.email)
      : [];

  return pushCard(
    gmailMessageCard({
      attachments: listSignableAttachments(message),
      contracts,
      links,
      messageId: event.gmail.messageId,
      // Contracts with yourself are not much use; the section is left out.
      sender:
        sender && sender.email !== user.email.toLowerCase() ? sender : null,
      subject,
    }),
  );
}

async function showDriveItems(context: AddonHandlerContext) {
  const { event, links, user } = context;
  const items = event.drive?.selectedItems ?? [];
  const cardItems: DriveCardItem[] = await Promise.all(
    items.slice(0, 5).map(async (item) => ({
      contracts: await listContractsFromDriveFile(user.id, item.id),
      hasFileScope: item.hasFileScope,
      id: item.id,
      kind: driveFileKind(item.mimeType),
      title: item.title,
    })),
  );

  return pushCard(driveItemsCard(cardItems, links));
}

async function runAction(context: AddonHandlerContext): Promise<RenderActions> {
  const parameters = context.event.parameters;

  switch (parameters.action) {
    case "send-attachment":
      return sendAttachment(context, parameters.partId ?? "");
    case "send-drive-file":
      return sendDriveFile(context, parameters.fileId ?? "");
    case "request-file-scope":
      return parameters.fileId
        ? requestFileScope(parameters.fileId)
        : notify("Select the file again.");
    case "nudge":
      return nudge(context, parameters.envelopeId ?? "");
    default:
      return notify(
        "That button no longer works. Close the panel and open it again.",
      );
  }
}

// One person's documents sent from the add-on, per hour: converting and
// storing a document is the heaviest thing it does.
const SEND_LIMIT = 30;
const SEND_WINDOW_MS = 60 * 60 * 1000;

async function sendAllowed(userId: string): Promise<boolean> {
  const decision = await consumeRateLimit({
    key: `google-addon-send:${userId}`,
    limit: SEND_LIMIT,
    windowMs: SEND_WINDOW_MS,
  });

  return decision.allowed;
}

function describeDraftFailure(error: unknown): string {
  if (
    error instanceof DocumentImportError ||
    error instanceof DocumentConversionError ||
    error instanceof EnvelopeMutationError
  ) {
    return error.message;
  }

  if (error instanceof ImportDraftAccountError) {
    return "Verify your email address in SignuDoc before sending documents.";
  }

  return "The document could not be made into a draft. Try uploading it in SignuDoc instead.";
}

/** A signer's name when the email gave none: the start of the address. */
function signerName(sender: GmailSender): string {
  return (sender.name ?? sender.email.split("@")[0] ?? sender.email).slice(
    0,
    200,
  );
}

async function sendAttachment(
  context: AddonHandlerContext,
  partId: string,
): Promise<RenderActions> {
  const { event, links, user } = context;
  const tokens = gmailTokens(event);

  if (!tokens || !event.gmail || !partId) {
    return notify("Open the email again, then choose the document.");
  }

  // The message is the one open now, never one named by the button: the
  // event's access token only reaches the open message anyway.
  const messageId = event.gmail.messageId;

  if (!(await sendAllowed(user.id))) {
    return notify(
      "Too many documents sent from here in the last hour. Try again later.",
    );
  }

  let message;
  let bytes: Buffer;

  try {
    message = await getOpenMessage(messageId, tokens);
  } catch (error) {
    context.log("Reading the open Gmail message failed.", error);
    return notify(describeGoogleFailure(error));
  }

  // Gmail's attachment ids change from one read to the next, so the button
  // names the part and the id is read again here.
  const attachment = listSignableAttachments(message).find(
    (candidate) => candidate.partId === partId,
  );

  if (!attachment) {
    return notify("That attachment is no longer in this email.");
  }

  if (attachment.tooLarge) {
    return notify(
      "The document is larger than 20 MB, the most SignuDoc takes.",
    );
  }

  try {
    bytes = await getAttachmentBytes(
      messageId,
      attachment.attachmentId,
      tokens,
    );
  } catch (error) {
    context.log("Reading a Gmail attachment failed.", error);
    return notify(describeGoogleFailure(error));
  }

  const { sender } = readMessageSummary(message);
  let envelopeId: string;
  let fileName: string;

  try {
    const pdf = await convertToPdf({
      accessToken: event.userOAuthToken,
      bytes,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
    });

    fileName = pdf.fileName;
    ({ envelopeId } = await createDraftFromDocument({
      bytes: pdf.bytes,
      fileName: pdf.fileName,
      source: { kind: "gmail", ref: `${messageId}/${partId}` },
      userId: user.id,
    }));
  } catch (error) {
    context.log("Making a draft from a Gmail attachment failed.", error);
    return notify(describeDraftFailure(error));
  }

  await recordEnvelopeSource({
    envelopeId,
    kind: "gmail",
    ref: `${messageId}/${partId}`,
    userId: user.id,
  }).catch((error: unknown) => {
    context.log("Noting a draft's Gmail source failed.", error);
  });

  // The sender of the email is suggested as the first signer: the sender of
  // the envelope sees it on the next page and can change it.
  let suggestedSigner: GmailSender | null = null;

  if (sender && sender.email !== user.email.toLowerCase()) {
    try {
      await replaceDraftEnvelopeSigners(user.id, envelopeId, {
        signers: [{ email: sender.email, name: signerName(sender) }],
      });
      suggestedSigner = sender;
    } catch (error) {
      // The draft is still there; the signers are added on the next page.
      context.log("Suggesting the email's sender as a signer failed.", error);
    }
  }

  return pushCard(
    draftCreatedCard({
      envelopeId,
      fileName,
      siteUrl: links.siteUrl,
      suggestedSigner,
    }),
  );
}

async function sendDriveFile(
  context: AddonHandlerContext,
  fileId: string,
): Promise<RenderActions> {
  const { event, links, user } = context;

  if (!fileId || !event.userOAuthToken) {
    return notify("Select the file again.");
  }

  const selected = event.drive?.selectedItems.find(
    (item) => item.id === fileId,
  );

  // Not given to the add-on yet: Drive asks the person for this one file.
  if (selected && !selected.hasFileScope) {
    return requestFileScope(fileId);
  }

  if (!(await sendAllowed(user.id))) {
    return notify(
      "Too many documents sent from here in the last hour. Try again later.",
    );
  }

  let metadata;

  try {
    metadata = await getDriveFileMetadata(fileId, event.userOAuthToken);
  } catch (error) {
    if (
      error instanceof DriveApiError &&
      (error.status === 403 || error.status === 404)
    ) {
      return requestFileScope(fileId);
    }

    context.log("Reading a Drive file's details failed.", error);
    return notify(describeGoogleFailure(error));
  }

  const kind = driveFileKind(metadata.mimeType);

  if (!kind) {
    return notify(
      "Only PDFs, Word files and Google Docs can be sent for signature.",
    );
  }

  let pdf: Awaited<ReturnType<typeof convertToPdf>>;

  try {
    if (kind === "google-doc") {
      pdf = await exportGoogleFileToPdf({
        accessToken: event.userOAuthToken,
        fileId,
      });
    } else {
      const bytes = await downloadDriveFile(fileId, event.userOAuthToken);

      pdf = await convertToPdf({
        accessToken: event.userOAuthToken,
        bytes,
        fileName: metadata.name,
        mimeType: metadata.mimeType,
      });
    }
  } catch (error) {
    if (error instanceof DriveApiError) {
      context.log("Reading a Drive file failed.", error);
      return notify(describeGoogleFailure(error));
    }

    context.log("Converting a Drive file to PDF failed.", error);
    return notify(describeDraftFailure(error));
  }

  let envelopeId: string;

  try {
    ({ envelopeId } = await createDraftFromDocument({
      bytes: pdf.bytes,
      fileName: pdf.fileName,
      source: { kind: "drive", ref: fileId },
      userId: user.id,
    }));
  } catch (error) {
    context.log("Making a draft from a Drive file failed.", error);
    return notify(describeDraftFailure(error));
  }

  await recordEnvelopeSource({
    envelopeId,
    kind: "drive",
    ref: fileId,
    userId: user.id,
  }).catch((error: unknown) => {
    context.log("Noting a draft's Drive source failed.", error);
  });

  return pushCard(
    draftCreatedCard({
      envelopeId,
      fileName: pdf.fileName,
      siteUrl: links.siteUrl,
      suggestedSigner: null,
    }),
  );
}

async function nudge(
  context: AddonHandlerContext,
  envelopeId: string,
): Promise<RenderActions> {
  const { user } = context;

  if (!envelopeId) {
    return notify(
      "That button no longer works. Close the panel and open it again.",
    );
  }

  // The same limit as the envelope page's button (api/envelopes/[id]/nudge).
  const decision = await consumeRateLimit({
    key: `envelope-nudge:${user.id}:${envelopeId}`,
    limit: 5,
    windowMs: 60 * 60 * 1000,
  });

  if (!decision.allowed) {
    return notify("Too many reminders for this envelope. Try again later.");
  }

  try {
    // Only the sender's own envelope, and only once the wait since the last
    // reminder is over; sendManualEnvelopeNudge checks both.
    const result = await sendManualEnvelopeNudge(user.id, envelopeId, {
      senderEmail: user.email,
      senderName: user.name,
    });

    return notify(`Reminder sent to ${result.signerName}.`);
  } catch (error) {
    if (error instanceof ReminderMutationError) {
      return notify(error.message);
    }

    context.log("Sending a reminder from the add-on failed.", error);
    return notify("The reminder could not be sent. Try again from SignuDoc.");
  }
}
