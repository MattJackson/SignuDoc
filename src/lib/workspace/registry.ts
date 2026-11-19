import { googleWorkspace } from "./providers/google/index.ts";
import type { EnvSource } from "../utils/env.ts";
import {
  getWorkspaceSettings,
  resolveWorkspaceSetting,
  type ResolvedWorkspaceSetting,
  type WorkspaceSettingKey,
  type WorkspaceSettings,
} from "./settings.ts";
import type {
  WorkspaceAddIn,
  WorkspaceCapability,
  WorkspaceContext,
  WorkspaceDirectory,
  WorkspaceFiles,
  WorkspaceProviderPackage,
} from "./types.ts";

// The installed workspace providers, and which one serves each capability.
//
// Adding a provider is one folder under providers/ exporting a
// WorkspaceProviderPackage, and one entry in WORKSPACE_PROVIDERS. Nothing
// that calls the functions below changes.
//
// Configuration picks a provider per capability: WORKSPACE_DIRECTORY_PROVIDER,
// WORKSPACE_FILES_PROVIDER, WORKSPACE_ADDIN_PROVIDER, or the same in
// Settings. WORKSPACE_PROVIDER (or its setting) is the default for every
// capability not chosen on its own, so one provider for everything is one
// setting. With nothing chosen, no capability has a provider.

export const WORKSPACE_PROVIDERS: readonly WorkspaceProviderPackage[] = [
  googleWorkspace,
];

const CAPABILITY_SETTINGS: Record<WorkspaceCapability, WorkspaceSettingKey> = {
  addIn: "addIn.provider",
  directory: "directory.provider",
  files: "files.provider",
};

export function findWorkspaceProvider(
  id: string | null | undefined,
  providers: readonly WorkspaceProviderPackage[] = WORKSPACE_PROVIDERS,
): WorkspaceProviderPackage | null {
  const normalized = id?.trim().toLowerCase();

  return providers.find((provider) => provider.id === normalized) ?? null;
}

const warned = new Set<string>();

function warnOnce(message: string) {
  if (!warned.has(message)) {
    warned.add(message);
    console.warn(`[workspace] ${message}`);
  }
}

export type CapabilityChoice = {
  provider: WorkspaceProviderPackage | null;
  /** Where the choice comes from; "none" when no provider serves it. */
  source: ResolvedWorkspaceSetting["source"];
};

/**
 * The provider for one capability: its own setting first, then the
 * default provider. A provider that is unknown, or that does not offer the
 * capability, counts as none.
 */
export function resolveCapabilityProvider(
  capability: WorkspaceCapability,
  stored: WorkspaceSettings | null,
  env: EnvSource = process.env,
  providers: readonly WorkspaceProviderPackage[] = WORKSPACE_PROVIDERS,
): CapabilityChoice {
  const own = resolveWorkspaceSetting(
    CAPABILITY_SETTINGS[capability],
    stored,
    env,
  );
  const setting = own.value
    ? own
    : resolveWorkspaceSetting("workspace.provider", stored, env);

  if (!setting.value) {
    return { provider: null, source: "none" };
  }

  const provider = findWorkspaceProvider(setting.value, providers);

  if (!provider) {
    warnOnce(
      `Unknown workspace provider "${setting.value}"; none is used. Installed: ${providers.map((item) => item.id).join(", ")}.`,
    );
    return { provider: null, source: "none" };
  }

  if (!provider[capability]) {
    // The default provider need not offer everything; one chosen for this
    // capability by name should.
    if (setting === own) {
      warnOnce(
        `${provider.label} does not offer the ${capability} capability.`,
      );
    }

    return { provider: null, source: "none" };
  }

  return { provider, source: setting.source };
}

/**
 * Every provider the configuration names, for its identity and checks in
 * Settings: the default one and each one chosen for a capability.
 */
export function configuredWorkspaceProviders(
  stored: WorkspaceSettings | null,
  env: EnvSource = process.env,
  providers: readonly WorkspaceProviderPackage[] = WORKSPACE_PROVIDERS,
): WorkspaceProviderPackage[] {
  const keys: WorkspaceSettingKey[] = [
    "workspace.provider",
    ...Object.values(CAPABILITY_SETTINGS),
  ];
  const found: WorkspaceProviderPackage[] = [];

  for (const key of keys) {
    const provider = findWorkspaceProvider(
      resolveWorkspaceSetting(key, stored, env).value,
      providers,
    );

    if (provider && !found.includes(provider)) {
      found.push(provider);
    }
  }

  return found;
}

/**
 * The stored settings and the environment, for building capabilities. A
 * settings read that fails counts as nothing stored, so a database hiccup
 * can only turn the optional parts off, never break a page.
 */
export async function getWorkspaceContext(
  env: EnvSource = process.env,
): Promise<WorkspaceContext> {
  try {
    return { env, settings: await getWorkspaceSettings() };
  } catch (error) {
    console.warn(
      "[workspace] Could not read the workspace settings:",
      error instanceof Error ? error.message : error,
    );
    return { env, settings: {} };
  }
}

/** The directory, or null when no provider serves it or it is off. */
export async function getWorkspaceDirectory(
  env: EnvSource = process.env,
): Promise<WorkspaceDirectory | null> {
  const context = await getWorkspaceContext(env);
  const { provider } = resolveCapabilityProvider(
    "directory",
    context.settings,
    env,
  );

  return provider?.directory?.(context) ?? null;
}

/** Files, or null when no provider serves them or they are off. */
export async function getWorkspaceFiles(
  env: EnvSource = process.env,
): Promise<WorkspaceFiles | null> {
  const context = await getWorkspaceContext(env);
  const { provider } = resolveCapabilityProvider(
    "files",
    context.settings,
    env,
  );

  return provider?.files?.(context) ?? null;
}

/** The add-in, or null when no provider serves it or it is off. */
export async function getWorkspaceAddIn(
  env: EnvSource = process.env,
): Promise<WorkspaceAddIn | null> {
  const context = await getWorkspaceContext(env);
  const { provider } = resolveCapabilityProvider(
    "addIn",
    context.settings,
    env,
  );

  return provider?.addIn?.(context) ?? null;
}
