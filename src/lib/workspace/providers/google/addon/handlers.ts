import {
  listEnvelopesFromSource,
  listEnvelopesWithEmail,
} from "../../../add-in-envelopes.ts";
import {
  addInSendAllowed,
  createAddInDraft,
  describeAddInDraftFailure,
  nudgeFromAddIn,
  type AddInAccount,
} from "../../../add-in-support.ts";
import { convertToPdf, type ConvertedPdf } from "../drive/convert.ts";
import { DriveApiError } from "../drive/drive-api.ts";
import {
  draftCreatedCard,
  driveItemsCard,
  gmailMessageCard,
  homepageCard,
  messageCard,
  notify,
  pushCard,
  requestFileScope,
  TOO_LARGE_MESSAGE,
  type DriveCardItem,
  type RenderActions,
  type SiteLinks,
} from "./cards.ts";
import type { AddonAction } from "./config.ts";
import {
  isSendableDriveFile,
  needsFileAccess,
  readDriveFileAsPdf,
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

// What each of the add-on's endpoints does, once the request is verified
// as Google's and the person's account found (add-on.ts). Every call to
// Google here is made as that person, with the tokens Google put in the
// event: nothing is read with the site's own service account.
//
// - homepage: a short card for Gmail or Drive with nothing open.
// - gmail-message: the open email's PDF and Word attachments, and the
//   person's envelopes that involve its sender.
// - drive-items: for each selected file, a way to send it (after asking
//   for the file if the add-on has not been given it) and the person's
//   envelopes made from it.
// - action: the buttons on those cards: send an attachment or a file for
//   signature, ask for a file, or nudge a signer.
//
// A document sent from here becomes a draft (add-in-support.ts), with its
// source noted on the envelope; the person chooses the signers, places
// the fields and sends it on the site, from the link on the card.

export type AddonHandlerContext = {
  account: AddInAccount;
  event: AddonEvent;
  links: SiteLinks;
  /** For log lines; never shown to the person. */
  log: (message: string, error: unknown) => void;
};

const PROVIDER = "google";

export async function handleAddonAction(
  action: AddonAction,
  context: AddonHandlerContext,
): Promise<RenderActions> {
  switch (action) {
    case "homepage":
      return pushCard(
        homepageCard(context.links.siteUrl, context.event.hostApp),
      );
    case "gmail-message":
      return showGmailMessage(context);
    case "drive-items":
      return showDriveItems(context);
    case "action":
      return runButton(context);
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

  return "Google could not be reached just now. Try again in a moment.";
}

const DRAFT_FAILED =
  "The document could not be made into a draft. Try uploading it in SignuDoc instead.";

/** The email's sender, unless it is the person themselves. */
function otherSender(
  sender: GmailSender | null,
  account: AddInAccount,
): GmailSender | null {
  return sender && sender.email !== account.email.toLowerCase() ? sender : null;
}

async function showGmailMessage(context: AddonHandlerContext) {
  const { account, event, links } = context;
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

  const { subject } = readMessageSummary(message);
  // Envelopes with yourself are not much use; the section is left out.
  const sender = otherSender(readMessageSummary(message).sender, account);

  return pushCard(
    gmailMessageCard({
      attachments: listSignableAttachments(message),
      envelopes: sender
        ? await listEnvelopesWithEmail(account.id, sender.email)
        : [],
      links,
      sender,
      subject,
    }),
  );
}

async function showDriveItems(context: AddonHandlerContext) {
  const { account, event, links } = context;
  const items = event.drive?.selectedItems ?? [];
  const cardItems: DriveCardItem[] = await Promise.all(
    items.slice(0, 5).map(async (item) => ({
      envelopes: await listEnvelopesFromSource(account.id, {
        kind: "file",
        provider: PROVIDER,
        ref: item.id,
      }),
      hasFileScope: item.hasFileScope,
      id: item.id,
      sendable: isSendableDriveFile(item.mimeType),
      title: item.title,
    })),
  );

  return pushCard(driveItemsCard(cardItems, links));
}

async function runButton(context: AddonHandlerContext): Promise<RenderActions> {
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

const TOO_MANY_SENT =
  "Too many documents sent from here in the last hour. Try again later.";

/** A signer's name when the email gave none: the start of the address. */
function signerName(sender: GmailSender): string {
  return (sender.name ?? sender.email.split("@")[0] ?? sender.email).slice(
    0,
    200,
  );
}

async function makeDraft(
  context: AddonHandlerContext,
  pdf: ConvertedPdf,
  source: { kind: "file" | "mail"; ref: string },
  sender: GmailSender | null,
): Promise<RenderActions> {
  const { account, links } = context;
  let draft;

  try {
    draft = await createAddInDraft({
      bytes: pdf.bytes,
      fileName: pdf.fileName,
      // The sender of the email is suggested as the first signer: the
      // person sees it on the next page and can change it.
      signer: sender ? { email: sender.email, name: signerName(sender) } : null,
      source: { ...source, provider: PROVIDER },
      userId: account.id,
    });
  } catch (error) {
    const known = describeAddInDraftFailure(error);

    if (!known) {
      context.log("Making a draft from the add-on failed.", error);
    }

    return notify(known ?? DRAFT_FAILED);
  }

  return pushCard(
    draftCreatedCard({
      fileName: pdf.fileName,
      suggestedSigner: draft.signerAdded ? sender : null,
      url: `${links.siteUrl}${draft.path}`,
    }),
  );
}

async function sendAttachment(
  context: AddonHandlerContext,
  partId: string,
): Promise<RenderActions> {
  const { account, event } = context;
  const tokens = gmailTokens(event);

  if (!tokens || !event.gmail || !partId) {
    return notify("Open the email again, then choose the document.");
  }

  // The message is the one open now, never one named by the button: the
  // event's access token only reaches the open message anyway.
  const messageId = event.gmail.messageId;

  if (!(await addInSendAllowed(account.id))) {
    return notify(TOO_MANY_SENT);
  }

  let message;
  let bytes: Uint8Array;

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
    return notify(TOO_LARGE_MESSAGE);
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

  let pdf: ConvertedPdf;

  try {
    // A Word file is converted through the person's own Drive (drive.file).
    pdf = await convertToPdf({
      accessToken: event.userOAuthToken,
      bytes,
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
    });
  } catch (error) {
    const known = describeAddInDraftFailure(error);

    if (!known) {
      context.log("Converting a Gmail attachment failed.", error);
    }

    return notify(known ?? DRAFT_FAILED);
  }

  return makeDraft(
    context,
    pdf,
    { kind: "mail", ref: `${messageId}/${partId}` },
    otherSender(readMessageSummary(message).sender, account),
  );
}

async function sendDriveFile(
  context: AddonHandlerContext,
  fileId: string,
): Promise<RenderActions> {
  const { account, event } = context;

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

  if (!(await addInSendAllowed(account.id))) {
    return notify(TOO_MANY_SENT);
  }

  let pdf: ConvertedPdf;

  try {
    pdf = await readDriveFileAsPdf(fileId, event.userOAuthToken);
  } catch (error) {
    if (needsFileAccess(error)) {
      return requestFileScope(fileId);
    }

    const known = describeAddInDraftFailure(error);

    if (!known) {
      context.log("Reading a Drive file failed.", error);
    }

    return notify(known ?? describeGoogleFailure(error));
  }

  return makeDraft(context, pdf, { kind: "file", ref: fileId }, null);
}

async function nudge(
  context: AddonHandlerContext,
  envelopeId: string,
): Promise<RenderActions> {
  if (!envelopeId) {
    return notify(
      "That button no longer works. Close the panel and open it again.",
    );
  }

  try {
    return notify(await nudgeFromAddIn(context.account, envelopeId));
  } catch (error) {
    context.log("Sending a reminder from the add-on failed.", error);
    return notify("The reminder could not be sent. Try again from SignuDoc.");
  }
}
