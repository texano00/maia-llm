import type { SqlDatabase } from "../../db/database.js";

export interface UseCaseSummary {
  id: string;
  title: string;
  description: string;
  imageUrl: string | null;
  position: number;
  models: string[];
}

/**
 * The curated basic-mode list.
 *
 * A use case always ships its full ordered model list, even when some entries are
 * currently unsupported: the client decides which entry it can run and explains
 * the choice, instead of the server hiding a curated intent.
 */
export function createUseCaseReader(db: SqlDatabase) {
  return async function listEnabledUseCases(): Promise<UseCaseSummary[]> {
    const rows = (await db.query(
      `SELECT id, title, description, image_url, position
         FROM use_cases WHERE enabled = 1 ORDER BY position, created_at`
    )) as unknown as Array<{
      id: string;
      title: string;
      description: string;
      image_url: string | null;
      position: number;
    }>;

    const useCases: UseCaseSummary[] = [];

    for (const row of rows) {
      const models = (await db.query(
        `SELECT model_id FROM use_case_models WHERE use_case_id = ? ORDER BY position`,
        [row.id]
      )) as unknown as Array<{ model_id: string }>;

      useCases.push({
        id: row.id,
        title: row.title,
        description: row.description,
        imageUrl: row.image_url,
        position: Number(row.position),
        models: models.map((model) => model.model_id)
      });
    }

    return useCases;
  };
}
