import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import {
  FileLanguageLifecycleStore,
  InMemoryLanguageLifecycleStore,
  LanguageLifecycleStore,
} from "./language-lifecycle-store";
import {
  LanguageScanPin,
  StoredLanguagePolicy,
} from "./language-lifecycle-types";

function storedPolicy(version: string, digest: string): StoredLanguagePolicy {
  return {
    version,
    languages: [
      { language: "solidity", stage: "supported", extensions: [".sol"] },
    ],
    digest,
    publishedAt: 1,
  };
}

function pin(
  tenantId: string,
  scanId: string,
  pinnedAt = 1,
  fingerprint = "f",
): LanguageScanPin {
  return {
    tenantId,
    scanId,
    policyVersion: "1.0.0",
    policyDigest: "d",
    asOf: "2026-10-18",
    decisions: [],
    unlistedAction: "analyze",
    fingerprint,
    pinnedAt,
  };
}

const tempDirs: string[] = [];

afterAll(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function fileStore(): Promise<FileLanguageLifecycleStore> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gasguard-langlc-"));
  tempDirs.push(dir);
  return new FileLanguageLifecycleStore(dir);
}

describe.each<[string, () => Promise<LanguageLifecycleStore>]>([
  [
    "InMemoryLanguageLifecycleStore",
    async () => new InMemoryLanguageLifecycleStore(),
  ],
  ["FileLanguageLifecycleStore", fileStore],
])("%s", (_name, create) => {
  let store: LanguageLifecycleStore;

  beforeEach(async () => {
    store = await create();
  });

  describe("policy", () => {
    it("starts empty", async () => {
      expect(await store.getPolicy()).toBeUndefined();
      expect(await store.listPolicyHistory()).toEqual([]);
    });

    it("writes only against the expected digest", async () => {
      expect(await store.putPolicy(storedPolicy("1.0.0", "d1"), "stale")).toBe(
        "conflict",
      );
      expect(await store.putPolicy(storedPolicy("1.0.0", "d1"), null)).toBe(
        "written",
      );
      expect(await store.putPolicy(storedPolicy("1.1.0", "d2"), null)).toBe(
        "conflict",
      );
      expect(await store.putPolicy(storedPolicy("1.1.0", "d2"), "d1")).toBe(
        "written",
      );
      expect((await store.getPolicy())?.version).toBe("1.1.0");
    });

    it("keeps an ordered history of published policies", async () => {
      await store.putPolicy(storedPolicy("1.0.0", "d1"), null);
      await store.putPolicy(storedPolicy("1.1.0", "d2"), "d1");
      await store.putPolicy(storedPolicy("2.0.0", "d3"), "d1"); // conflict
      expect((await store.listPolicyHistory()).map((p) => p.version)).toEqual([
        "1.0.0",
        "1.1.0",
      ]);
    });

    it("lets exactly one of two concurrent publishes win", async () => {
      await store.putPolicy(storedPolicy("1.0.0", "d1"), null);
      const results = await Promise.all([
        store.putPolicy(storedPolicy("1.1.0", "a"), "d1"),
        store.putPolicy(storedPolicy("1.1.0", "b"), "d1"),
      ]);
      expect([...results].sort()).toEqual(["conflict", "written"]);
    });

    it("returns copies that cannot mutate stored state", async () => {
      await store.putPolicy(storedPolicy("1.0.0", "d1"), null);
      const read = await store.getPolicy();
      read!.languages[0].stage = "retired";
      expect((await store.getPolicy())!.languages[0].stage).toBe("supported");
    });
  });

  describe("tenant settings", () => {
    it("keeps settings per tenant", async () => {
      await store.putTenantSettings({
        tenantId: "tenant-a",
        previewOptIns: ["cairo"],
        updatedAt: 1,
      });
      expect(await store.getTenantSettings("tenant-b")).toBeUndefined();
      expect(
        (await store.getTenantSettings("tenant-a"))?.previewOptIns,
      ).toEqual(["cairo"]);
    });
  });

  describe("pins", () => {
    it("are write-once", async () => {
      expect(await store.createPin(pin("t", "s", 1, "first"))).toBe("written");
      expect(await store.createPin(pin("t", "s", 2, "second"))).toBe("exists");
      expect((await store.getPin("t", "s"))?.fingerprint).toBe("first");
    });

    it("are isolated per tenant even when scan ids collide", async () => {
      await store.createPin(pin("tenant-a", "scan-1", 1, "a"));
      await store.createPin(pin("tenant-b", "scan-1", 1, "b"));
      expect((await store.getPin("tenant-a", "scan-1"))?.fingerprint).toBe("a");
      expect((await store.getPin("tenant-b", "scan-1"))?.fingerprint).toBe("b");
      expect(await store.getPin("tenant-c", "scan-1")).toBeUndefined();
    });

    it("are purged strictly before the cutoff", async () => {
      await store.createPin(pin("t", "old", 99));
      await store.createPin(pin("t", "edge", 100));
      await store.createPin(pin("u", "new", 101));
      expect(await store.deletePinsBefore(100)).toBe(1);
      expect(await store.getPin("t", "old")).toBeUndefined();
      expect(await store.getPin("t", "edge")).toBeDefined();
      expect(await store.deletePinsBefore(100)).toBe(0);
    });
  });
});

describe("FileLanguageLifecycleStore", () => {
  it("rejects an empty root", () => {
    expect(() => new FileLanguageLifecycleStore(" ")).toThrow(TypeError);
  });

  it("never derives paths from identifiers", async () => {
    const store = await fileStore();
    const root = (store as unknown as { rootDir: string }).rootDir;
    await store.createPin(pin("../../escape", "../../../etc/passwd"));
    await store.putTenantSettings({
      tenantId: "../../escape",
      previewOptIns: [],
      updatedAt: 1,
    });
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else {
          files.push(path.relative(root, full));
        }
      }
    };
    await walk(root);
    expect(files).toHaveLength(2);
    for (const file of files) {
      expect(file).toMatch(
        /^tenants\/[0-9a-f]{64}\/(settings|pins\/[0-9a-f]{64})\.json$/,
      );
    }
    expect(
      (await store.getPin("../../escape", "../../../etc/passwd"))?.tenantId,
    ).toBe("../../escape");
  });

  it("refuses a pin file that does not match its key", async () => {
    const store = await fileStore();
    await store.createPin(pin("tenant-a", "scan-1"));
    const root = (store as unknown as { rootDir: string }).rootDir;
    const tenantDir = (await fs.readdir(path.join(root, "tenants")))[0];
    const pinsDir = path.join(root, "tenants", tenantDir, "pins");
    const [file] = await fs.readdir(pinsDir);
    await fs.writeFile(
      path.join(pinsDir, file),
      JSON.stringify(pin("tenant-b", "scan-1")),
    );
    await expect(store.getPin("tenant-a", "scan-1")).rejects.toThrow(
      /does not match/,
    );
  });

  it("persists across instances over the same directory", async () => {
    const store = await fileStore();
    const root = (store as unknown as { rootDir: string }).rootDir;
    await store.putPolicy(storedPolicy("1.0.0", "d1"), null);
    await store.createPin(pin("t", "s"));
    const reopened = new FileLanguageLifecycleStore(root);
    expect((await reopened.getPolicy())?.digest).toBe("d1");
    expect(await reopened.getPin("t", "s")).toEqual(pin("t", "s"));
  });
});
