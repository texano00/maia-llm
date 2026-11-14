import { randomUUID } from "node:crypto";
import type { SqlDatabase } from "../../db/database.js";
import type { CatalogModel } from "./model.js";

export type UseCaseErrorCode = "VALIDATION" | "CONFLICT" | "NOT_FOUND";

export class UseCaseError extends Error {
  constructor(
    readonly code: UseCaseErrorCode,
    message: string
  ) {
    super(message);
    this.name = "UseCaseError";
  }
}

export interface UseCaseModelView {
  id: string;
  /** False when the current snapshot marks the model unsupported. */
  supported: boolean;
  engine: string | null;
  /** True when the model is no longer present in the snapshot at all. */
  missing: boolean;
}

export interface UseCaseAdminView {
  id: string;
  title: string;
  description: string;
  imageUrl: string | null;
  position: number;
  enabled: boolean;
  version: number;
  models: UseCaseModelView[];
}

export interface UseCaseInput {
  title: string;
  description: string;
  imageUrl?: string | null | undefined;
  models: string[];
  enabled?: boolean | undefined;
}

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"]
]);

interface UseCaseRow {
  id: string;
  title: string;
  description: string;
  image_url: string | null;
  position: number;
  enabled: number;
  version: number;
}

/**
 * Curated basic-mode use cases.
 *
 * A use case always keeps its full ordered model list: entries that the current
 * snapshot marks unsupported are reported as warnings, never silently dropped, so
 * the maintainer sees what a client will skip. Saves are versioned, so two
 * administrators editing the same use case cannot overwrite each other.
 */
export class UseCaseAdminService {
  constructor(
    private readonly options: {
      db: SqlDatabase;
      /** The models of the published snapshot, keyed by id. */
      currentModels: () => Promise<Map<string, CatalogModel>>;
      now?: () => number;
    }
  ) {}

  async list(includeDisabled: boolean): Promise<UseCaseAdminView[]> {
    const rows = (await this.options.db.query(
      `SELECT id, title, description, image_url, position, enabled, version
         FROM use_cases ${includeDisabled ? "" : "WHERE enabled = 1"}
        ORDER BY position, created_at`
    )) as unknown as UseCaseRow[];

    const models = await this.options.currentModels();
    const views: UseCaseAdminView[] = [];

    for (const row of rows) {
      views.push({
        id: row.id,
        title: row.title,
        description: row.description,
        imageUrl: row.image_url,
        position: Number(row.position),
        enabled: row.enabled === 1,
        version: Number(row.version),
        models: await this.modelsFor(row.id, models)
      });
    }

    return views;
  }

  async create(input: UseCaseInput, actorId: string | null): Promise<UseCaseAdminView> {
    const validated = await this.validate(input);
    const now = new Date(this.now()).toISOString();
    const id = randomUUID();
    const position = await this.nextPosition();

    await this.options.db.execute(
      `INSERT INTO use_cases
        (id, title, description, image_url, position, enabled, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        id,
        validated.title,
        validated.description,
        validated.imageUrl,
        position,
        validated.enabled ? 1 : 0,
        now,
        now
      ]
    );
    await this.replaceModels(id, validated.models);
    await this.audit(actorId, "use_case_created", id);

    return (await this.get(id)) as UseCaseAdminView;
  }

  async update(
    id: string,
    input: UseCaseInput & { version: number },
    actorId: string | null
  ): Promise<UseCaseAdminView> {
    const existing = await this.get(id);
    if (!existing) {
      throw new UseCaseError("NOT_FOUND", "unknown use case");
    }

    if (existing.version !== input.version) {
      throw new UseCaseError(
        "CONFLICT",
        "this use case was changed by someone else; reload it before saving"
      );
    }

    const validated = await this.validate(input);
    const now = new Date(this.now()).toISOString();

    await this.options.db.execute(
      `UPDATE use_cases
          SET title = ?, description = ?, image_url = ?, enabled = ?, version = version + 1,
              updated_at = ?
        WHERE id = ? AND version = ?`,
      [
        validated.title,
        validated.description,
        validated.imageUrl,
        validated.enabled ? 1 : 0,
        now,
        id,
        input.version
      ]
    );
    await this.replaceModels(id, validated.models);
    await this.audit(actorId, "use_case_updated", id);

    const updated = await this.get(id);
    if (!updated) {
      throw new UseCaseError("NOT_FOUND", "unknown use case");
    }

    return updated;
  }

  async remove(id: string, actorId: string | null): Promise<boolean> {
    const result = await this.options.db.execute(`DELETE FROM use_cases WHERE id = ?`, [id]);
    if (result.changes === 0) {
      return false;
    }

    await this.options.db.execute(`DELETE FROM use_case_models WHERE use_case_id = ?`, [id]);
    await this.audit(actorId, "use_case_deleted", id);
    return true;
  }

  async reorder(ids: string[], actorId: string | null): Promise<UseCaseAdminView[]> {
    for (const [position, id] of ids.entries()) {
      await this.options.db.execute(
        `UPDATE use_cases SET position = ?, updated_at = ? WHERE id = ?`,
        [position, new Date(this.now()).toISOString(), id]
      );
    }
    await this.audit(actorId, "use_cases_reordered", ids.join(","));

    return this.list(true);
  }

  /** Stores a validated image and returns the public path to it. */
  async saveAsset(input: { contentType: string; base64: string }): Promise<{ url: string }> {
    const extension = IMAGE_TYPES.get(input.contentType);
    if (!extension) {
      throw new UseCaseError("VALIDATION", "image must be PNG, JPEG or WebP");
    }

    const bytes = Buffer.from(input.base64, "base64");
    if (bytes.length === 0) {
      throw new UseCaseError("VALIDATION", "image is empty");
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      throw new UseCaseError("VALIDATION", "image is larger than 2 MB");
    }

    const name = `${randomUUID()}.${extension}`;
    // The SQL port carries scalars only; a ≤2 MB image becomes ~2.7 MB of text.
    await this.options.db.execute(
      `INSERT INTO catalogue_assets (name, content_type, data_base64, created_at)
       VALUES (?, ?, ?, ?)`,
      [name, input.contentType, bytes.toString("base64"), new Date(this.now()).toISOString()]
    );

    return { url: `/assets/${name}` };
  }

  async readAsset(name: string): Promise<{ contentType: string; bytes: Buffer } | null> {
    // `name` is generated here (`uuid.ext`); anything else cannot be a row.
    if (!/^[A-Za-z0-9-]+\.(png|jpg|webp)$/.test(name)) {
      return null;
    }

    const rows = (await this.options.db.query(
      `SELECT content_type, data_base64 FROM catalogue_assets WHERE name = ?`,
      [name]
    )) as unknown as Array<{ content_type: string; data_base64: string }>;
    const row = rows[0];

    return row
      ? { contentType: row.content_type, bytes: Buffer.from(row.data_base64, "base64") }
      : null;
  }

  private async get(id: string): Promise<UseCaseAdminView | null> {
    const rows = (await this.options.db.query(
      `SELECT id, title, description, image_url, position, enabled, version
         FROM use_cases WHERE id = ?`,
      [id]
    )) as unknown as UseCaseRow[];
    const row = rows[0];
    if (!row) {
      return null;
    }

    const models = await this.options.currentModels();

    return {
      id: row.id,
      title: row.title,
      description: row.description,
      imageUrl: row.image_url,
      position: Number(row.position),
      enabled: row.enabled === 1,
      version: Number(row.version),
      models: await this.modelsFor(row.id, models)
    };
  }

  private async modelsFor(
    useCaseId: string,
    snapshot: Map<string, CatalogModel>
  ): Promise<UseCaseModelView[]> {
    const rows = (await this.options.db.query(
      `SELECT model_id FROM use_case_models WHERE use_case_id = ? ORDER BY position`,
      [useCaseId]
    )) as unknown as Array<{ model_id: string }>;

    return rows.map((row) => {
      const model = snapshot.get(row.model_id);
      return {
        id: row.model_id,
        supported: model?.supported === true,
        engine: model?.engine ?? null,
        missing: model === undefined
      };
    });
  }

  private async validate(input: UseCaseInput) {
    const title = input.title?.trim() ?? "";
    const description = input.description?.trim() ?? "";
    const models = [...new Set(input.models ?? [])];

    if (title.length < 3 || title.length > 120) {
      throw new UseCaseError("VALIDATION", "title must be between 3 and 120 characters");
    }
    if (description.length < 10 || description.length > 2_000) {
      throw new UseCaseError("VALIDATION", "description must be between 10 and 2000 characters");
    }
    if (models.length === 0) {
      throw new UseCaseError("VALIDATION", "a use case needs at least one model");
    }

    const snapshot = await this.options.currentModels();
    const unknown = models.filter((id) => !snapshot.has(id));
    if (unknown.length > 0) {
      throw new UseCaseError(
        "VALIDATION",
        `these models are not in the current snapshot: ${unknown.join(", ")}`
      );
    }

    return {
      title,
      description,
      imageUrl: input.imageUrl ?? null,
      enabled: input.enabled ?? true,
      models
    };
  }

  private async replaceModels(useCaseId: string, models: string[]): Promise<void> {
    await this.options.db.execute(`DELETE FROM use_case_models WHERE use_case_id = ?`, [useCaseId]);
    for (const [position, modelId] of models.entries()) {
      await this.options.db.execute(
        `INSERT INTO use_case_models (use_case_id, model_id, position) VALUES (?, ?, ?)`,
        [useCaseId, modelId, position]
      );
    }
  }

  private async nextPosition(): Promise<number> {
    const rows = (await this.options.db.query(
      `SELECT COALESCE(MAX(position), 0) AS position FROM use_cases`
    )) as unknown as Array<{ position: number }>;

    return Number(rows[0]?.position ?? 0) + 1;
  }

  private async audit(actorId: string | null, action: string, target: string): Promise<void> {
    await this.options.db.execute(
      `INSERT INTO audit_entries (occurred_at, actor_kind, actor_id, action, target, detail_json)
       VALUES (?, 'admin', ?, ?, ?, NULL)`,
      [new Date(this.now()).toISOString(), actorId, action, target]
    );
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
