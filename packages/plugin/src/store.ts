import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SCHEMA_VERSION = 1;
export const STORE_FILE = "state.json";

export interface Installation {
  installId: string;
}

export interface RelayBinding {
  url: string;
  connectedAt: string;
}

export interface Device {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
  revokedAt?: string;
}

export interface LinkRecord {
  tokenHash: string;
  createdAt: string;
  expiresAt: string;
  epoch: number;
}

export interface AccessStats {
  success: number;
  failure: number;
  lastSuccessAt?: string;
}

export interface StoreState {
  schemaVersion: number;
  installation: Installation | null;
  relay: RelayBinding | null;
  devices: Device[];
  link: LinkRecord | null;
  stats: AccessStats;
}

export function emptyState(): StoreState {
  return {
    schemaVersion: SCHEMA_VERSION,
    installation: null,
    relay: null,
    devices: [],
    link: null,
    stats: { success: 0, failure: 0 },
  };
}

function isUsable(value: unknown): value is StoreState {
  if (typeof value !== "object" || value === null) return false;
  const s = value as Partial<StoreState>;
  return (
    s.schemaVersion === SCHEMA_VERSION &&
    Array.isArray(s.devices) &&
    typeof s.stats === "object" &&
    s.stats !== null &&
    "installation" in s &&
    "relay" in s &&
    "link" in s
  );
}

/** 状态文件读写：schema 校验、原子替换、0600 权限、损坏文件保留改名。 */
export class Store {
  readonly #dir: string;
  #state: StoreState = emptyState();

  constructor(dir: string) {
    this.#dir = dir;
  }

  get dir(): string {
    return this.#dir;
  }

  get state(): StoreState {
    return this.#state;
  }

  get file(): string {
    return join(this.#dir, STORE_FILE);
  }

  async load(): Promise<StoreState> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.#state = emptyState();
        return this.#state;
      }
      throw err;
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }

    if (isUsable(parsed)) {
      this.#state = parsed;
      return this.#state;
    }

    const stamp = new Date().toISOString().replaceAll(":", "-");
    await rename(this.file, join(this.#dir, `state.corrupt-${stamp}.json`));
    this.#state = emptyState();
    return this.#state;
  }

  async save(next: StoreState): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    const body = `${JSON.stringify(next, null, 2)}\n`;
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, body, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.file);
    this.#state = next;
  }

  async update(mutate: (state: StoreState) => StoreState | void): Promise<StoreState> {
    const draft: StoreState = structuredClone(this.#state);
    const result = mutate(draft);
    await this.save(result ?? draft);
    return this.#state;
  }
}
