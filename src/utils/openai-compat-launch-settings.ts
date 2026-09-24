import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';

import type { Settings } from '../types/config';
import { getCcsDir } from './config-manager';
import { stripAnthropicRoutingEnv } from './shell-executor';

export interface OpenAICompatLaunchSettings {
  settingsPath: string;
  cleanup: () => void;
}

export interface OpenAICompatLaunchSettingsOptions {
  /**
   * When true, snapshot the isolated settings to a durable, profile-scoped
   * location under ~/.ccs/cache/isolated-settings/ instead of an ephemeral $TMPDIR.
   * This ensures background fleet daemons respawning sessions can continue to read
   * the settings file after the parent CCS launch process exits (Issue #1734).
   * Default: false (ephemeral tempdir with automatic deletion on cleanup).
   */
  durable?: boolean;
}

// SIBLING HELPER: src/cliproxy/executor/launch-settings.ts (prepareLaunchSettings)
// solves the same problem by OVERLAYING resolved routing values instead of
// stripping them. This strip-based variant is required where callers deliberately
// delete a routing key (e.g. ANTHROPIC_API_KEY in settings-flow) and need it
// ABSENT from the launch settings. Do not unify without an explicit force-absent
// key list — see issue #1609.
export function createOpenAICompatLaunchSettings(
  settingsPath: string,
  settings: Settings,
  options?: OpenAICompatLaunchSettingsOptions
): OpenAICompatLaunchSettings {
  const launchSettings = JSON.parse(JSON.stringify(settings)) as Settings;
  const sanitizedEnv = Object.fromEntries(
    Object.entries(stripAnthropicRoutingEnv({ ...(launchSettings.env ?? {}) })).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );

  if (Object.keys(sanitizedEnv).length > 0) {
    launchSettings.env = sanitizedEnv;
  } else {
    delete launchSettings.env;
  }

  const contentStr = JSON.stringify(launchSettings, null, 2) + '\n';

  if (options?.durable) {
    // Durable mode: key one private directory per canonical settings path so each
    // profile has exactly one snapshot, atomically replaced on content updates.
    // Do not fall back to $TMPDIR: failure here must fail the launch early rather than
    // causing a deferred background fleet respawn crash (Issue #1734).
    const pathHash = createHash('sha256')
      .update(path.resolve(settingsPath))
      .digest('hex')
      .slice(0, 16);
    const durableDir = path.join(getCcsDir(), 'cache', 'isolated-settings', pathHash);
    fs.mkdirSync(durableDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(durableDir, 0o700);
    const launchSettingsPath = path.join(durableDir, path.basename(settingsPath));
    const tempFile = path.join(durableDir, `.${path.basename(settingsPath)}.${randomUUID()}.tmp`);

    let renamed = false;
    try {
      fs.writeFileSync(tempFile, contentStr, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      fs.renameSync(tempFile, launchSettingsPath);
      renamed = true;
    } finally {
      if (!renamed) {
        try {
          fs.unlinkSync(tempFile);
        } catch {
          // best-effort cleanup on failure
        }
      }
    }
    return {
      settingsPath: launchSettingsPath,
      cleanup: () => {
        // No-op in durable mode: snapshot persists for background fleet daemon respawns.
      },
    };
  }

  // Ephemeral mode (default / headless): create isolated tempdir in os.tmpdir() and purge on cleanup.
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-openai-compat-settings-'));
  fs.chmodSync(tempDir, 0o700);

  const launchSettingsPath = path.join(tempDir, path.basename(settingsPath));
  fs.writeFileSync(launchSettingsPath, contentStr, {
    encoding: 'utf8',
    mode: 0o600,
  });

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  };

  return {
    settingsPath: launchSettingsPath,
    cleanup,
  };
}
