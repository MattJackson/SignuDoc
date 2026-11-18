import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";

import {
  checkForUpdate,
  clearUpdateCheckCache,
  compareVersions,
  DEFAULT_RELEASES_REPO,
  DEFAULT_UPSTREAM_REPO,
  getDeployRepository,
  getReleasesRepo,
  getRunningCommit,
  getRunningVersion,
  getUpdateStatus,
  getUpstreamBase,
  parseVersion,
  toReleaseInfo,
} from "./software-update.ts";

// Several tests rely on the defaults, and on what they read from the process
// environment when given none. A copy or a developer shell that sets these
// must not turn them red, so they are set aside while the file runs.
const BUILD_SETTINGS = /^(SIGNUDOC_RELEASES_REPO|NEXT_PUBLIC_SIGNUDOC_)/;
const setAside = new Map<string, string>();

before(() => {
  for (const [name, value] of Object.entries(process.env)) {
    if (BUILD_SETTINGS.test(name) && value !== undefined) {
      setAside.set(name, value);
      delete process.env[name];
    }
  }
});

after(() => {
  for (const [name, value] of setAside) {
    process.env[name] = value;
  }
});

beforeEach(() => clearUpdateCheckCache());

function release(overrides: Record<string, unknown> = {}) {
  return {
    body: "## Added\n- Update checks",
    draft: false,
    html_url: "https://github.com/MattJackson/SignuDoc/releases/tag/v0.2.0",
    name: "SignuDoc 0.2.0",
    prerelease: false,
    published_at: "2026-11-15T10:00:00Z",
    tag_name: "v0.2.0",
    ...overrides,
  };
}

function fakeFetch(response: () => Response) {
  let calls = 0;
  const impl = (() => {
    calls += 1;
    return Promise.resolve(response());
  }) as unknown as typeof fetch;

  return { calls: () => calls, impl };
}

test("versions compare by number, and a pre-release comes first", () => {
  assert.ok(compareVersions("0.1.0", "0.2.0") < 0);
  assert.ok(compareVersions("0.10.0", "0.9.9") > 0);
  assert.equal(compareVersions("v1.2.3", "1.2.3"), 0);
  assert.ok(compareVersions("1.0.0-beta.1", "1.0.0") < 0);
  assert.equal(compareVersions("not a version", "1.0.0"), 0);
});

test("the running version and commit come from the build", () => {
  assert.equal(
    getRunningVersion({ NEXT_PUBLIC_SIGNUDOC_VERSION: "0.2.0" }),
    "0.2.0",
  );
  assert.equal(getRunningVersion({}), "0.0.0");
  assert.equal(
    getRunningCommit({
      VERCEL_GIT_COMMIT_SHA: "8678487b2550620e9f8141f6c78c333421127d9c",
    }),
    "8678487",
  );
  assert.equal(getRunningCommit({ VERCEL_GIT_COMMIT_SHA: "<script>" }), null);
});

test("the deploy repository comes from Vercel's git variables", () => {
  const repository = getDeployRepository({
    VERCEL_ENV: "production",
    VERCEL_GIT_COMMIT_REF: "main",
    VERCEL_GIT_PROVIDER: "github",
    VERCEL_GIT_REPO_OWNER: "acme",
    VERCEL_GIT_REPO_SLUG: "signudoc",
  });

  assert.deepEqual(repository, {
    actionsUrl:
      "https://github.com/acme/signudoc/actions/workflows/update-signudoc.yml",
    addWorkflowUrl:
      "https://github.com/acme/signudoc/new/main?filename=.github%2Fworkflows%2Fupdate-signudoc.yml",
    branch: "main",
    isReleaseSource: false,
    owner: "acme",
    slug: "signudoc",
    url: "https://github.com/acme/signudoc",
  });
});

test("no deploy repository off GitHub, or with odd names", () => {
  assert.equal(getDeployRepository({}), null);
  assert.equal(
    getDeployRepository({
      VERCEL_GIT_PROVIDER: "gitlab",
      VERCEL_GIT_REPO_OWNER: "acme",
      VERCEL_GIT_REPO_SLUG: "signudoc",
    }),
    null,
  );
  assert.equal(
    getDeployRepository({
      VERCEL_GIT_PROVIDER: "github",
      VERCEL_GIT_REPO_OWNER: "acme/../x",
      VERCEL_GIT_REPO_SLUG: "signudoc",
    }),
    null,
  );
});

test("a preview deployment still points at main, and the release source is recognised", () => {
  const repository = getDeployRepository({
    VERCEL_ENV: "preview",
    VERCEL_GIT_COMMIT_REF: "signudoc-update/v0.2.0",
    VERCEL_GIT_PROVIDER: "github",
    VERCEL_GIT_REPO_OWNER: "mattjackson",
    VERCEL_GIT_REPO_SLUG: "signudoc",
  });

  assert.equal(repository?.branch, "main");
  assert.equal(repository?.isReleaseSource, true);

  // The original project is not where this install takes releases from.
  assert.equal(
    getDeployRepository({
      VERCEL_GIT_PROVIDER: "github",
      VERCEL_GIT_REPO_OWNER: "NYLLON-SOFTWARE",
      VERCEL_GIT_REPO_SLUG: "SignuDoc",
    })?.isReleaseSource,
    false,
  );
});

test("releases come from SIGNUDOC_RELEASES_REPO, then package.json, then the fork", () => {
  assert.equal(getReleasesRepo({}), DEFAULT_RELEASES_REPO);
  assert.equal(
    getReleasesRepo({
      NEXT_PUBLIC_SIGNUDOC_REPOSITORY: "acme/signudoc-fork",
    }),
    "acme/signudoc-fork",
  );
  assert.equal(
    getReleasesRepo({
      NEXT_PUBLIC_SIGNUDOC_REPOSITORY: "acme/signudoc-fork",
      SIGNUDOC_RELEASES_REPO: "https://github.com/other/SignuDoc.git",
    }),
    "other/SignuDoc",
  );
  // Not owner/repository: ignored.
  assert.equal(
    getReleasesRepo({ SIGNUDOC_RELEASES_REPO: "../../evil" }),
    DEFAULT_RELEASES_REPO,
  );
});

test("the upstream base is the recorded release of the original project", () => {
  assert.deepEqual(
    getUpstreamBase({ NEXT_PUBLIC_SIGNUDOC_UPSTREAM_VERSION: "0.4.0" }),
    {
      repository: DEFAULT_UPSTREAM_REPO,
      url: "https://github.com/NYLLON-SOFTWARE/SignuDoc",
      version: "0.4.0",
    },
  );
  assert.equal(getUpstreamBase({}).version, null);
  assert.equal(
    getUpstreamBase({ NEXT_PUBLIC_SIGNUDOC_UPSTREAM_VERSION: "latest" })
      .version,
    null,
  );
});

test("the status names the release source, its links and the upstream base", () => {
  const status = getUpdateStatus(null, {
    NEXT_PUBLIC_SIGNUDOC_UPSTREAM_VERSION: "0.4.0",
    NEXT_PUBLIC_SIGNUDOC_VERSION: "0.5.0",
    SIGNUDOC_RELEASES_REPO: "acme/signudoc",
  });

  assert.equal(status.current, "0.5.0");
  assert.equal(status.releasesRepo, "acme/signudoc");
  assert.equal(status.releasesUrl, "https://github.com/acme/signudoc/releases");
  assert.equal(
    status.workflowSourceUrl,
    "https://raw.githubusercontent.com/acme/signudoc/main/.github/workflows/update-signudoc.yml",
  );
  assert.equal(status.upstream.version, "0.4.0");
});

test("the check asks the release source's API, and a new source is asked again", async () => {
  const asked: string[] = [];
  const github = (async (input: string | URL | Request) => {
    asked.push(String(input));
    return Response.json(release());
  }) as typeof fetch;

  await checkForUpdate({
    current: "0.1.0",
    fetchImpl: github,
    releasesRepo: "MattJackson/SignuDoc",
  });
  await checkForUpdate({
    current: "0.1.0",
    fetchImpl: github,
    releasesRepo: "acme/signudoc",
  });

  assert.deepEqual(asked, [
    "https://api.github.com/repos/MattJackson/SignuDoc/releases/latest",
    "https://api.github.com/repos/acme/signudoc/releases/latest",
  ]);
});

test("release info is read from GitHub's answer", () => {
  assert.deepEqual(toReleaseInfo(release()), {
    name: "SignuDoc 0.2.0",
    notes: "## Added\n- Update checks",
    publishedAt: "2026-11-15T10:00:00Z",
    url: "https://github.com/MattJackson/SignuDoc/releases/tag/v0.2.0",
    version: "0.2.0",
  });
  assert.equal(toReleaseInfo(release({ prerelease: true })), null);
  assert.equal(toReleaseInfo(release({ tag_name: "latest" })), null);
  // A link anywhere else is replaced with the project's own.
  assert.equal(
    toReleaseInfo(release({ html_url: "https://evil.example/x" }))?.url,
    "https://github.com/MattJackson/SignuDoc/releases/tag/v0.2.0",
  );
});

test("a newer release is an update, and the answer is cached", async () => {
  const github = fakeFetch(() => Response.json(release()));
  const first = await checkForUpdate({
    current: "0.1.0",
    fetchImpl: github.impl,
  });
  const second = await checkForUpdate({
    current: "0.1.0",
    fetchImpl: github.impl,
  });

  assert.equal(first.ok && first.updateAvailable, true);
  assert.deepEqual(second, first);
  assert.equal(github.calls(), 1);
});

test("the same release is not an update", async () => {
  const github = fakeFetch(() => Response.json(release()));
  const result = await checkForUpdate({
    current: "0.2.0",
    fetchImpl: github.impl,
  });

  assert.equal(result.ok && result.updateAvailable, false);
});

test("failures are reported, not thrown, and retried sooner", async () => {
  let now = 1_000_000;
  const limited = fakeFetch(() => new Response("{}", { status: 403 }));
  const result = await checkForUpdate({
    current: "0.1.0",
    fetchImpl: limited.impl,
    now: () => now,
  });

  assert.equal(result.ok, false);
  assert.match(!result.ok ? result.error : "", /limiting/);

  now += 6 * 60 * 1000;
  const offline = fakeFetch(() => {
    throw new TypeError("fetch failed");
  });
  const later = await checkForUpdate({
    current: "0.1.0",
    fetchImpl: offline.impl,
    now: () => now,
  });

  assert.equal(offline.calls(), 1);
  assert.match(!later.ok ? later.error : "", /could not be reached/);

  const none = fakeFetch(() => new Response("{}", { status: 404 }));

  clearUpdateCheckCache();
  const missing = await checkForUpdate({
    current: "0.1.0",
    fetchImpl: none.impl,
  });

  assert.match(!missing.ok ? missing.error : "", /no published release/);
});

test("the fork's version is above the upstream release it is built on", () => {
  // docs/development.md, "Maintaining the fork": the fork numbers its own
  // releases, always above the upstream version it is based on, and with no
  // pre-release part, so the update check compares them plainly.
  const manifest = JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "..", "..", "package.json"),
      "utf8",
    ),
  ) as {
    repository: { url: string };
    upstream: { repository: string; version: string };
    version: string;
  };

  assert.equal(parseVersion(manifest.version)?.pre, null);
  assert.ok(parseVersion(manifest.upstream.version));
  assert.ok(compareVersions(manifest.version, manifest.upstream.version) > 0);
  assert.match(manifest.upstream.repository, /^[\w.-]+\/[\w.-]+$/);
  assert.match(
    manifest.repository.url,
    /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/,
  );
});
