import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../../src/db/migrate.js";
import { migrations } from "../../src/db/migrations/index.js";
import { openSqliteDatabase, type SqliteDatabase } from "../../src/db/sqlite.js";
import type { CatalogueClient } from "../../src/services/catalogue/huggingface.js";
import type { HubModelPayload } from "../../src/services/catalogue/model.js";
import { SnapshotService } from "../../src/services/catalogue/snapshot-service.js";

const payloads: HubModelPayload[] = [
  {
    id: "Qwen/Qwen2.5-7B-Instruct",
    pipeline_tag: "text-generation",
    downloads: 100,
    siblings: [
      { rfilename: "config.json", size: 1 },
      { rfilename: "model.safetensors", size: 1_000 }
    ]
  },
  {
    id: "openai-community/gpt2",
    pipeline_tag: "text-generation",
    downloads: 50,
    siblings: [
      { rfilename: "config.json", size: 1 },
      { rfilename: "model.safetensors", size: 1_000 }
    ]
  }
];

function fakeClient(overrides: Partial<CatalogueClient> = {}): CatalogueClient {
  return {
    async listModels() {
      return payloads;
    },
    async getFiles() {
      return [
        { rfilename: "config.json", size: 1 },
        { rfilename: "model.safetensors", size: 1_000 }
      ];
    },
    async hasChatTemplate(modelId) {
      return modelId !== "openai-community/gpt2";
    },
    ...overrides
  };
}

describe("catalogue snapshots", () => {
  let directory: string;
  let db: SqliteDatabase;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "maia-snapshot-"));
    db = openSqliteDatabase({ file: join(directory, "maia.sqlite") });
    await migrate(db, migrations);
  });

  afterEach(async () => {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("publishes an immutable version with the supported verdict", async () => {
    const service = new SnapshotService({ db, client: fakeClient() });
    const run = await service.refresh("scheduled");

    expect(run.outcome).toBe("success");
    expect(run.version).toBe(1);

    const current = await service.current();
    expect(current?.snapshot.version).toBe(1);
    expect(current?.snapshot.modelCount).toBe(2);
    expect(current?.models.find((model) => model.id === "openai-community/gpt2")?.supported).toBe(
      false
    );
    expect(current?.models.find((model) => model.id === "Qwen/Qwen2.5-7B-Instruct")?.engine).toBe(
      "vllm"
    );

    // A second pass publishes a new version; the first one is untouched.
    const second = await service.refresh("manual");
    expect(second.version).toBe(2);
    const versions = (await db.query(`SELECT version FROM snapshots ORDER BY version`)) as unknown as Array<{
      version: number;
    }>;
    expect(versions.map((row) => Number(row.version))).toEqual([1, 2]);
  });

  it("keeps the previous snapshot when the provider fails", async () => {
    const service = new SnapshotService({ db, client: fakeClient() });
    await service.refresh("scheduled");

    const failing = new SnapshotService({
      db,
      client: fakeClient({
        async listModels() {
          throw new Error("Hugging Face catalogue listing failed with 503");
        }
      })
    });

    const run = await failing.refresh("scheduled");
    expect(run.outcome).toBe("failed");

    const current = await failing.current();
    expect(current?.snapshot.version).toBe(1);

    const runs = await failing.listRuns();
    expect(runs[0]?.outcome).toBe("failed");
    expect(runs[0]?.error).toMatch(/503/);
  });

  it("refuses to publish a snapshot when nothing could be mapped", async () => {
    const service = new SnapshotService({
      db,
      client: fakeClient({
        async getFiles() {
          throw new Error("model not found");
        }
      })
    });

    const run = await service.refresh("scheduled");

    expect(run.outcome).toBe("failed");
    await expect(service.current()).resolves.toBeNull();
  });

  it("runs a single pass at a time", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const service = new SnapshotService({
      db,
      client: fakeClient({
        async listModels() {
          await gate;
          return payloads;
        }
      })
    });

    const first = service.refresh("manual");
    const second = await service.refresh("manual");
    expect(second.outcome).toBe("already-running");

    release?.();
    await expect(first).resolves.toMatchObject({ outcome: "success" });
  });

  it("prunes snapshots beyond the retention window", async () => {
    const service = new SnapshotService({ db, client: fakeClient(), retention: 1 });
    await service.refresh("scheduled");
    await service.refresh("scheduled");

    const rows = (await db.query(`SELECT version FROM snapshots`)) as unknown as Array<{
      version: number;
    }>;
    expect(rows.map((row) => Number(row.version))).toEqual([2]);
    // Models of the pruned snapshot go with it.
    const models = (await db.query(`SELECT COUNT(*) AS count FROM snapshot_models`)) as unknown as Array<{
      count: number;
    }>;
    expect(Number(models[0]?.count)).toBe(2);
  });
});
