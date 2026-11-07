import { readFileSync, renameSync } from "node:fs";
import { z } from "zod";
import { gpuReputationSchema } from "../reputation-contract.js";
import type { GpuReputationRepository } from "../repositories/gpu-reputation.js";

const legacyFileSchema = z.object({
  version: z.literal(1),
  gpus: z.array(gpuReputationSchema),
});

export interface LegacyImportResult {
  /** Machines copied out of the JSON file. */
  imported: number;
  /** Where the file was moved after a successful import, if it was moved. */
  archivedTo: string | null;
}

/**
 * One-time import of the JSON reputation file used before verdicts moved to the
 * database.
 *
 * Deliberately conservative: it only runs when the table is empty, so a
 * botched import can be retried without duplicating rows, and the source file
 * is renamed rather than deleted. A missing or unreadable file is not an error
 * — most deployments never had one.
 */
export async function importLegacyReputation(
  repository: GpuReputationRepository,
  options: { file: string },
): Promise<LegacyImportResult> {
  const empty: LegacyImportResult = { imported: 0, archivedTo: null };

  let raw: string;
  try {
    raw = readFileSync(options.file, "utf8");
  } catch {
    return empty;
  }

  if ((await repository.count()) > 0) {
    return empty;
  }

  let parsed;
  try {
    parsed = legacyFileSchema.safeParse(JSON.parse(raw));
  } catch {
    return empty;
  }

  if (!parsed.success) {
    return empty;
  }

  for (const record of parsed.data.gpus) {
    await repository.save(record);
  }

  const archivedTo = `${options.file}.imported`;
  try {
    renameSync(options.file, archivedTo);
  } catch {
    return { imported: parsed.data.gpus.length, archivedTo: null };
  }

  return { imported: parsed.data.gpus.length, archivedTo };
}
