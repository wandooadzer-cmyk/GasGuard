/**
 * Persistence boundary for language lifecycle policies, tenant settings, and
 * scan pins.
 *
 * The policy is platform-scoped. Writes are optimistic: `putPolicy` only
 * succeeds when the stored digest still equals the one the caller read, so two
 * operators publishing at once can never silently overwrite each other. Every
 * published policy is also kept in an append-only history for audit.
 *
 * Tenant settings and pins are tenant-scoped. Every read and write takes the
 * tenant id explicitly, and implementations must never resolve a record across
 * tenants, so one tenant cannot read or alter another's settings or pins even
 * when scan ids collide. Pins are write-once (`createPin`), which makes retries
 * idempotent.
 *
 * Implementations throw plain errors on storage failure; the service maps them
 * to the retryable STORE_UNAVAILABLE code.
 */

import * as crypto from "crypto";
import { promises as fs } from "fs";
import * as path from "path";
import {
  LanguageScanPin,
  StoredLanguagePolicy,
  TenantLanguageSettings,
} from "./language-lifecycle-types";

export type PolicyWriteResult = "written" | "conflict";
export type PinCreateResult = "written" | "exists";

export interface LanguageLifecycleStore {
  getPolicy(): Promise<StoredLanguagePolicy | undefined>;
  /**
   * Make `policy` current when the stored digest equals `expectedDigest`
   * (`null` means no policy may be stored yet), and append it to the history.
   */
  putPolicy(
    policy: StoredLanguagePolicy,
    expectedDigest: string | null,
  ): Promise<PolicyWriteResult>;
  /** Every published policy, oldest first. */
  listPolicyHistory(): Promise<StoredLanguagePolicy[]>;
  getTenantSettings(
    tenantId: string,
  ): Promise<TenantLanguageSettings | undefined>;
  putTenantSettings(settings: TenantLanguageSettings): Promise<void>;
  getPin(
    tenantId: string,
    scanId: string,
  ): Promise<LanguageScanPin | undefined>;
  /** Store `pin` unless a pin already exists for its tenant and scan. */
  createPin(pin: LanguageScanPin): Promise<PinCreateResult>;
  /** Remove pins created before `cutoff`; returns how many were removed. */
  deletePinsBefore(cutoff: number): Promise<number>;
}

export class InMemoryLanguageLifecycleStore implements LanguageLifecycleStore {
  // Stored serialized so callers can never mutate persisted state by reference.
  private current: string | undefined;
  private readonly history: string[] = [];
  private readonly settings: Map<string, string> = new Map();
  private readonly pins: Map<string, string> = new Map();

  async getPolicy(): Promise<StoredLanguagePolicy | undefined> {
    return this.current === undefined ? undefined : JSON.parse(this.current);
  }

  async putPolicy(
    policy: StoredLanguagePolicy,
    expectedDigest: string | null,
  ): Promise<PolicyWriteResult> {
    const stored =
      this.current === undefined
        ? null
        : (JSON.parse(this.current) as StoredLanguagePolicy).digest;
    if (stored !== expectedDigest) {
      return "conflict";
    }
    this.current = JSON.stringify(policy);
    this.history.push(this.current);
    return "written";
  }

  async listPolicyHistory(): Promise<StoredLanguagePolicy[]> {
    return this.history.map((raw) => JSON.parse(raw));
  }

  async getTenantSettings(
    tenantId: string,
  ): Promise<TenantLanguageSettings | undefined> {
    const raw = this.settings.get(tenantId);
    return raw === undefined ? undefined : JSON.parse(raw);
  }

  async putTenantSettings(settings: TenantLanguageSettings): Promise<void> {
    this.settings.set(settings.tenantId, JSON.stringify(settings));
  }

  async getPin(
    tenantId: string,
    scanId: string,
  ): Promise<LanguageScanPin | undefined> {
    const raw = this.pins.get(pinKey(tenantId, scanId));
    return raw === undefined ? undefined : JSON.parse(raw);
  }

  async createPin(pin: LanguageScanPin): Promise<PinCreateResult> {
    const key = pinKey(pin.tenantId, pin.scanId);
    if (this.pins.has(key)) {
      return "exists";
    }
    this.pins.set(key, JSON.stringify(pin));
    return "written";
  }

  async deletePinsBefore(cutoff: number): Promise<number> {
    let removed = 0;
    for (const [key, raw] of this.pins) {
      if ((JSON.parse(raw) as LanguageScanPin).pinnedAt < cutoff) {
        this.pins.delete(key);
        removed++;
      }
    }
    return removed;
  }

  pinCount(): number {
    return this.pins.size;
  }
}

/**
 * Durable store writing JSON files under `rootDir`:
 *
 *   policy/current.json            current policy
 *   policy/history/<seq>.json      every published policy, zero-padded order
 *   tenants/<sha256(tenant)>/settings.json
 *   tenants/<sha256(tenant)>/pins/<sha256(scan)>.json
 *
 * Paths are derived from SHA-256 digests of identifiers, never from the
 * identifiers themselves, so crafted ids cannot traverse outside `rootDir`, and
 * each tenant's records live in their own directory. Files are written to a
 * temporary name and renamed into place, so a crash mid-write leaves either the
 * old record or the new one, never a torn file.
 *
 * Conditional writes are serialized per key within this process. Deployments
 * that run several API processes against shared storage should use a database
 * store that performs the digest check as a single conditional update.
 */
export class FileLanguageLifecycleStore implements LanguageLifecycleStore {
  private readonly rootDir: string;
  private readonly locks: Map<string, Promise<unknown>> = new Map();

  constructor(rootDir: string) {
    if (typeof rootDir !== "string" || rootDir.trim() === "") {
      throw new TypeError("rootDir must be a non-empty string");
    }
    this.rootDir = path.resolve(rootDir);
  }

  getPolicy(): Promise<StoredLanguagePolicy | undefined> {
    return readJson<StoredLanguagePolicy>(this.currentPolicyPath());
  }

  putPolicy(
    policy: StoredLanguagePolicy,
    expectedDigest: string | null,
  ): Promise<PolicyWriteResult> {
    const file = this.currentPolicyPath();
    return this.withLock(file, async () => {
      const existing = await readJson<StoredLanguagePolicy>(file);
      if ((existing?.digest ?? null) !== expectedDigest) {
        return "conflict";
      }
      const historyDir = path.join(this.rootDir, "policy", "history");
      const sequence = (await readDirOrEmpty(historyDir)).filter((n) =>
        n.endsWith(".json"),
      ).length;
      // History first: a crash between the writes leaves an extra history
      // entry, never a current policy missing from the audit trail.
      await writeAtomic(
        path.join(historyDir, `${String(sequence).padStart(8, "0")}.json`),
        policy,
      );
      await writeAtomic(file, policy);
      return "written";
    });
  }

  async listPolicyHistory(): Promise<StoredLanguagePolicy[]> {
    const dir = path.join(this.rootDir, "policy", "history");
    const policies: StoredLanguagePolicy[] = [];
    for (const name of (await readDirOrEmpty(dir))
      .filter((n) => n.endsWith(".json"))
      .sort()) {
      policies.push(
        JSON.parse(await fs.readFile(path.join(dir, name), "utf8")),
      );
    }
    return policies;
  }

  async getTenantSettings(
    tenantId: string,
  ): Promise<TenantLanguageSettings | undefined> {
    const settings = await readJson<TenantLanguageSettings>(
      this.settingsPath(tenantId),
    );
    // Defence in depth: the digest path must hold the record it was asked for.
    if (settings && settings.tenantId !== tenantId) {
      throw new Error("Stored tenant settings do not match their key");
    }
    return settings;
  }

  putTenantSettings(settings: TenantLanguageSettings): Promise<void> {
    const file = this.settingsPath(settings.tenantId);
    return this.withLock(file, () => writeAtomic(file, settings));
  }

  async getPin(
    tenantId: string,
    scanId: string,
  ): Promise<LanguageScanPin | undefined> {
    return this.readPin(this.pinPath(tenantId, scanId), tenantId, scanId);
  }

  createPin(pin: LanguageScanPin): Promise<PinCreateResult> {
    const file = this.pinPath(pin.tenantId, pin.scanId);
    return this.withLock(file, async () => {
      if (await this.readPin(file, pin.tenantId, pin.scanId)) {
        return "exists";
      }
      await writeAtomic(file, pin);
      return "written";
    });
  }

  async deletePinsBefore(cutoff: number): Promise<number> {
    const tenantsDir = path.join(this.rootDir, "tenants");
    let removed = 0;
    for (const tenantDir of (await readDirOrEmpty(tenantsDir)).sort()) {
      const dir = path.join(tenantsDir, tenantDir, "pins");
      for (const name of (await readDirOrEmpty(dir)).sort()) {
        if (!name.endsWith(".json")) {
          continue;
        }
        const file = path.join(dir, name);
        const deleted = await this.withLock(file, async () => {
          const pin = await readJson<LanguageScanPin>(file);
          if (!pin || pin.pinnedAt >= cutoff) {
            return false;
          }
          await fs.rm(file, { force: true });
          return true;
        });
        if (deleted) {
          removed++;
        }
      }
    }
    return removed;
  }

  private async readPin(
    file: string,
    tenantId: string,
    scanId: string,
  ): Promise<LanguageScanPin | undefined> {
    const pin = await readJson<LanguageScanPin>(file);
    if (pin && (pin.tenantId !== tenantId || pin.scanId !== scanId)) {
      throw new Error("Stored scan pin does not match its key");
    }
    return pin;
  }

  private currentPolicyPath(): string {
    return path.join(this.rootDir, "policy", "current.json");
  }

  private settingsPath(tenantId: string): string {
    return path.join(
      this.rootDir,
      "tenants",
      digest(tenantId),
      "settings.json",
    );
  }

  private pinPath(tenantId: string, scanId: string): string {
    return path.join(
      this.rootDir,
      "tenants",
      digest(tenantId),
      "pins",
      `${digest(scanId)}.json`,
    );
  }

  private withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.catch(() => undefined);
    this.locks.set(key, settled);
    void settled.then(() => {
      if (this.locks.get(key) === settled) {
        this.locks.delete(key);
      }
    });
    return run;
  }
}

function pinKey(tenantId: string, scanId: string): string {
  return `${tenantId}\u0000${scanId}`;
}

function digest(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

async function writeAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value), {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readJson<T>(file: string): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
  return JSON.parse(raw) as T;
}

async function readDirOrEmpty(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if (isNotFound(error)) {
      return [];
    }
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
