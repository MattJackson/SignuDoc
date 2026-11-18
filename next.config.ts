import { readFileSync } from "node:fs";

import type { NextConfig } from "next";

// The version this deployment runs, compared with the latest release by
// "Check for updates" in Settings (src/lib/software-update.ts).
const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_SIGNUDOC_VERSION: version,
    // Whether Vercel BotID is on, decided once at build time so the browser
    // code that adds its proof and the server code that checks it cannot
    // disagree. It only works on Vercel, and is opt-in with BOTID=1. See
    // src/lib/security/botid.ts.
    NEXT_PUBLIC_BOTID:
      process.env.VERCEL === "1" && process.env.BOTID === "1" ? "1" : "",
  },
  experimental: {
    // With a proxy (src/proxy.ts), Next.js keeps a copy of each request body
    // and hands the route only the first 10 MB of it by default, without an
    // error. Uploads that go through the app (local disk, Google Cloud
    // Storage) can be the 20 MB upload limit plus the form around it, so
    // the copy may be larger. Cloud Run takes requests of up to 32 MB;
    // Vercel stops a request at 4.5 MB before it gets here, which is why it
    // uploads straight to Blob instead.
    proxyClientMaxBodySize: "25mb",
  },
  images: {
    unoptimized: true,
  },
  // The Docker image (Dockerfile) sets NEXT_OUTPUT=standalone to get a
  // self-contained server.js. Unset, as on Vercel, the build is unchanged.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // Finished PDFs are drawn with fonts read from disk at runtime, cut down
  // by a WebAssembly subsetter (src/lib/services/pdf-fonts.ts). Listing the
  // files here makes sure they are copied into the deployed functions.
  outputFileTracingIncludes: {
    "/api/**": [
      "./src/assets/fonts/*.ttf",
      "./node_modules/harfbuzzjs/dist/harfbuzz-subset.wasm",
    ],
  },
};

export default nextConfig;
