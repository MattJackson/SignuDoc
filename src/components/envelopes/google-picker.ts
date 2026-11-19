// Loads Google's Picker script once, for "Choose from Google Drive"
// (files-start.tsx). The page that uses it allows Google's script and
// frames in its Content Security Policy (src/proxy.ts).

const GOOGLE_API_SCRIPT = "https://apis.google.com/js/api.js";

export type PickedDocument = { id: string; mimeType?: string; name?: string };
export type PickerResponse = { action: string; docs?: PickedDocument[] };

export type DocsView = {
  setEnableDrives(enabled: boolean): DocsView;
  setIncludeFolders(included: boolean): DocsView;
  setMimeTypes(mimeTypes: string): DocsView;
  setSelectFolderEnabled(enabled: boolean): DocsView;
};

export type PickerBuilder = {
  addView(view: DocsView): PickerBuilder;
  build(): { setVisible(visible: boolean): void };
  enableFeature(feature: unknown): PickerBuilder;
  setAppId(appId: string): PickerBuilder;
  setCallback(callback: (response: PickerResponse) => void): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder;
  setTitle(title: string): PickerBuilder;
};

export type PickerNamespace = {
  Action: { CANCEL: string; LOADED?: string; PICKED: string };
  DocsView: new (viewId?: unknown) => DocsView;
  Feature: { SUPPORT_DRIVES: unknown };
  PickerBuilder: new () => PickerBuilder;
  ViewId: { DOCS: unknown };
};

type GoogleWindow = Window & {
  gapi?: {
    load(
      name: string,
      options: { callback: () => void; onerror?: () => void },
    ): void;
  };
  google?: { picker?: PickerNamespace };
};

let pickerLoading: Promise<PickerNamespace> | null = null;

export function loadPicker(): Promise<PickerNamespace> {
  const win = window as GoogleWindow;

  if (win.google?.picker) {
    return Promise.resolve(win.google.picker);
  }

  pickerLoading ??= new Promise<PickerNamespace>((resolve, reject) => {
    const whenGapi = () => {
      const gapi = (window as GoogleWindow).gapi;

      if (!gapi) {
        reject(new Error("Google's script did not load."));
        return;
      }

      gapi.load("picker", {
        callback: () => {
          const picker = (window as GoogleWindow).google?.picker;

          if (picker) {
            resolve(picker);
          } else {
            reject(new Error("The Google Picker did not load."));
          }
        },
        onerror: () => reject(new Error("The Google Picker did not load.")),
      });
    };

    if ((window as GoogleWindow).gapi) {
      whenGapi();
      return;
    }

    const script = document.createElement("script");

    script.async = true;
    script.src = GOOGLE_API_SCRIPT;
    script.onload = whenGapi;
    script.onerror = () => reject(new Error("Google's script did not load."));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    pickerLoading = null;
    throw error;
  });

  return pickerLoading;
}

/**
 * Shows the Google Picker (My Drive, then Shared Drives) and resolves with
 * the picked file's id, or null when the person closes it.
 */
export async function pickGoogleDriveFile(config: {
  accessToken: string;
  apiKey: string;
  appId: string;
  mimeTypes: readonly string[];
}): Promise<string | null> {
  const picker = await loadPicker();
  const mimeTypes = config.mimeTypes.join(",");
  const view = new picker.DocsView(picker.ViewId.DOCS)
    .setMimeTypes(mimeTypes)
    .setIncludeFolders(true)
    .setSelectFolderEnabled(false);
  const sharedDrivesView = new picker.DocsView(picker.ViewId.DOCS)
    .setMimeTypes(mimeTypes)
    .setIncludeFolders(true)
    .setSelectFolderEnabled(false)
    .setEnableDrives(true);

  return new Promise((resolve) => {
    new picker.PickerBuilder()
      .addView(view)
      .addView(sharedDrivesView)
      .enableFeature(picker.Feature.SUPPORT_DRIVES)
      .setAppId(config.appId)
      .setOAuthToken(config.accessToken)
      .setDeveloperKey(config.apiKey)
      .setOrigin(window.location.origin)
      .setTitle("Choose a document to send")
      .setCallback((result) => {
        if (result.action === picker.Action.PICKED) {
          resolve(result.docs?.[0]?.id ?? null);
        } else if (result.action === picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build()
      .setVisible(true);
  });
}
