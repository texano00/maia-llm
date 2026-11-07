import type { FailureReport } from "../failure-contract.js";
import type { FailureRecord, FailureRepository } from "../repositories/failures.js";

export class FailureService {
  constructor(
    private readonly options: {
      repository: FailureRepository;
      now?: () => number;
    }
  ) {}

  async record(report: FailureReport): Promise<number> {
    const now = this.options.now?.() ?? Date.now();
    return this.options.repository.append(
      { ...report, occurredAt: report.occurredAt ?? new Date(now).toISOString() },
      new Date(now).toISOString()
    );
  }

  async list(limit = 50): Promise<FailureRecord[]> {
    return this.options.repository.list(limit);
  }
}
