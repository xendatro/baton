import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HarnessId } from '@shared/schemas/agentRunner';

/**
 * The desktop app's settings on this machine (BAT-24): the Baton server and API key (encrypted
 * with the OS keychain when it can be), this machine's id and name, which folder each project
 * maps to, each harness's permission mode, and when exhausted harnesses reset.
 */

export interface FolderMapping {
  /** Absolute path, or null for the app's scratch folder of the project. */
  path: string | null;
  /** For display: `team/KEY — Name`. */
  label: string;
}

export interface AppConfig {
  serverUrl: string;
  /** Encrypted (base64) when `keyEncrypted`, else plain. */
  apiKey: string | null;
  keyEncrypted: boolean;
  machineId: string;
  machineName: string;
  /** Project id → folder. Projects without one aren't offered jobs here. */
  folders: Record<string, FolderMapping>;
  permissionModes: Partial<Record<HarnessId, string>>;
  /** Harness → when it may be used again (ms since epoch). */
  exhaustedUntil: Partial<Record<HarnessId, number>>;
  setupDone: boolean;
  /** Stop taking jobs on this machine (the server-side pause is separate). */
  pausedHere: boolean;
}

export interface SecretBox {
  available(): boolean;
  encrypt(text: string): string;
  decrypt(data: string): string;
}

export const DEFAULT_SERVER = 'https://www.passthebaton.dev';

function defaults(): AppConfig {
  return {
    serverUrl: DEFAULT_SERVER,
    apiKey: null,
    keyEncrypted: false,
    machineId: `m-${randomUUID()}`,
    machineName: os.hostname(),
    folders: {},
    permissionModes: {},
    exhaustedUntil: {},
    setupDone: false,
    pausedHere: false,
  };
}

export class ConfigStore {
  private value: AppConfig;
  private readonly file: string;

  constructor(
    dir: string,
    private readonly secrets: SecretBox,
  ) {
    this.file = path.join(dir, 'config.json');
    let loaded: Partial<AppConfig> = {};
    if (existsSync(this.file)) {
      try {
        loaded = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<AppConfig>;
      } catch {
        loaded = {};
      }
    }
    this.value = { ...defaults(), ...loaded };
    mkdirSync(dir, { recursive: true });
    this.save();
  }

  get(): Readonly<AppConfig> {
    return this.value;
  }

  update(patch: Partial<AppConfig>): void {
    this.value = { ...this.value, ...patch };
    this.save();
  }

  apiKey(): string | null {
    const { apiKey, keyEncrypted } = this.value;
    if (!apiKey) return null;
    try {
      return keyEncrypted ? this.secrets.decrypt(apiKey) : apiKey;
    } catch {
      return null;
    }
  }

  setApiKey(key: string | null): void {
    if (!key) {
      this.update({ apiKey: null, keyEncrypted: false });
      return;
    }
    const encrypted = this.secrets.available();
    this.update({ apiKey: encrypted ? this.secrets.encrypt(key) : key, keyEncrypted: encrypted });
  }

  /** The folder a project's jobs run in: its mapping, or a scratch folder the app creates. */
  folderFor(projectId: string, scratchRoot: string): string | null {
    const mapping = this.value.folders[projectId];
    if (!mapping) return null;
    if (mapping.path) return mapping.path;
    const scratch = path.join(scratchRoot, projectId);
    mkdirSync(scratch, { recursive: true });
    return scratch;
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.value, null, 2), { mode: 0o600 });
  }
}
