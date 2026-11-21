// Loads Google's Picker script once. Shared by "Choose from Google Drive"
// on the new-envelope page (drive-start.tsx) and the Picker test in
// Settings, Google Drive.

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
