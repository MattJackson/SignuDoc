# Third-Party Notices

SignuDoc includes bundled third-party assets that remain under their own
licenses. The project license applies to SignuDoc's code, but it does not
replace the licenses for redistributed third-party files.

## Bundled third-party assets

### 1. Great Vibes font

- **Bundled path:** `src/assets/fonts/GreatVibes-Regular.ttf`
- **Used by:** `src/lib/services/pdf-fonts.ts` (typed signatures)
- **License:** SIL Open Font License 1.1
- **Full license text:** `src/assets/fonts/LICENSE-GreatVibes-OFL.txt`

### 2. Noto Sans fonts

- **Bundled paths:** `src/assets/fonts/NotoSans-Regular.ttf`, `src/assets/fonts/NotoSans-Bold.ttf`
- **Source project:** https://github.com/notofonts/latin-greek-cyrillic (version 2.015, unhinted)
- **Used by:** `src/lib/services/pdf-fonts.ts` (text on signed PDFs and audit certificates)
- **License:** SIL Open Font License 1.1
- **Full license text:** `src/assets/fonts/LICENSE-NotoSans-OFL.txt`

### 3. Noto Sans CJK JP font (modified)

- **Bundled path:** `src/assets/fonts/NotoSansCJKjp-Regular.ttf`
- **Source project:** https://github.com/notofonts/noto-cjk (`Sans/Variable/TTF/NotoSansCJKjp-VF.ttf`)
- **Used by:** `src/lib/services/pdf-fonts.ts` (Chinese, Japanese and Korean text)
- **License:** SIL Open Font License 1.1
- **Full license text:** `src/assets/fonts/LICENSE-NotoSansCJK-OFL.txt`
- **Notes:** This is a modified version: fixed at weight 400, with only the default glyph of each character kept. The license file records how it was made.

### 4. Mozilla PDF.js legacy worker asset

- **Bundled path:** `public/pdfjs/5.5.207/legacy/build/pdf.worker.min.mjs`
- **Source project:** Mozilla PDF.js
- **License:** Apache License 2.0
- **Full license text:** `LICENSES/Apache-2.0.txt`

### 5. PDF.js standard fonts - PDFium-derived Foxit font files

- **Bundled path:** `public/pdfjs/5.5.207/standard_fonts/Foxit*.pfb`
- **Source project:** Mozilla PDF.js standard font assets
- **License text already bundled at:** `public/pdfjs/5.5.207/standard_fonts/LICENSE_FOXIT`
- **Notes:** The bundled notice identifies these files under the PDFium Authors copyright and license terms distributed with PDF.js.

### 6. PDF.js standard fonts - Liberation Sans

- **Bundled path:** `public/pdfjs/5.5.207/standard_fonts/LiberationSans-*.ttf`
- **Source project:** Mozilla PDF.js standard font assets
- **License:** SIL Open Font License 1.1
- **License text already bundled at:** `public/pdfjs/5.5.207/standard_fonts/LICENSE_LIBERATION`

## Trademarks and brand marks

`public/brands/` holds the marks of services SignuDoc can connect to. They
are trademarks of their owners and are not covered by SignuDoc's license.
They are shown only to name the service an integration connects to, at
their own proportions and colors, and do not mean that any of these
companies sponsors or endorses SignuDoc.

| File               | Mark         | Owner            | Source                                                                                                     |
| ------------------ | ------------ | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `google-g.svg`     | Google "G"   | Google LLC       | Google's sign-in branding assets (developers.google.com/identity/branding-guidelines), cropped to the mark |
| `google-drive.svg` | Google Drive | Google LLC       | Google Drive product icon                                                                                  |
| `gmail.svg`        | Gmail        | Google LLC       | Gmail product icon                                                                                         |
| `google-cloud.svg` | Google Cloud | Google LLC       | Google Cloud logo, mark only                                                                               |
| `slack.svg`        | Slack        | Salesforce, Inc. | Slack media kit mark                                                                                       |
| `resend.svg`       | Resend       | Resend, Inc.     | resend.com/brand icon                                                                                      |
| `vercel.svg`       | Vercel       | Vercel Inc.      | Vercel logomark                                                                                            |

The "Continue with Google" button on the sign-in page follows Google's
sign-in branding guidelines: the unmodified "G" on a white button with
Google's border color and text.

Google, Google Workspace, Google Drive, Gmail and Google Cloud are
trademarks of Google LLC. Slack is a trademark of Salesforce, Inc. Resend
is a trademark of Resend, Inc. Vercel is a trademark of Vercel Inc.

## Notes

- Include this file and the referenced license texts in release archives and other redistributions of the repository contents.
- If additional third-party assets are vendored into the repository later, add them here alongside their license texts.
