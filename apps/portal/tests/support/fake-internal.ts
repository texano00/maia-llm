import {
  InternalApiError,
  type AccountSummary,
  type Capability,
  type InternalAccountsApi
} from "../../src/services/internal-client.js";

export interface FakeAccount {
  id: string;
  email: string;
  capabilities?: Capability[];
  activeSessions?: number;
  lastSeenAt?: string | null;
}

export interface FakeInternalOptions {
  accounts?: FakeAccount[];
}

export interface FakeInternal {
  api: InternalAccountsApi;
  /** Live rows, so a test can assert what a change actually stored. */
  accounts: AccountSummary[];
  calls: {
    changes: Array<{ accountId: string; grant?: Capability; revoke?: Capability }>;
  };
}

/**
 * Stands in for the product's `/internal/*` API. The portal must work against
 * this exactly as it works against the real one: same shapes, same failures.
 */
export function createFakeInternal(options: FakeInternalOptions = {}): FakeInternal {
  const accounts: AccountSummary[] = (options.accounts ?? []).map((account) => ({
    id: account.id,
    email: account.email,
    createdAt: "2026-11-01T09:00:00.000Z",
    lastSeenAt: account.lastSeenAt === undefined ? null : account.lastSeenAt,
    capabilities: [...(account.capabilities ?? [])],
    activeSessions: account.activeSessions ?? 0
  }));

  const calls: FakeInternal["calls"] = { changes: [] };

  const api: InternalAccountsApi = {
    configured: true,

    async listAccounts(query) {
      const search = (query.search ?? "").trim().toLowerCase();
      const matching = search
        ? accounts.filter((account) => account.email.toLowerCase().includes(search))
        : accounts;
      const offset = query.offset ?? 0;
      const limit = query.limit ?? 50;

      return { total: matching.length, accounts: matching.slice(offset, offset + limit) };
    },

    async findAccount(email: string) {
      const wanted = email.trim().toLowerCase();
      return accounts.find((entry) => entry.email.toLowerCase() === wanted) ?? null;
    },

    async changeCapability(accountId, change) {
      calls.changes.push({ accountId, ...change });
      const account = accounts.find((entry) => entry.id === accountId);
      if (!account) {
        throw new InternalApiError(404, "not_found");
      }

      if (change.grant && !account.capabilities.includes(change.grant)) {
        account.capabilities = [...account.capabilities, change.grant].sort();
        if (change.grant === "operator" && !account.capabilities.includes("debug")) {
          account.capabilities = [...account.capabilities, "debug"].sort();
        }
      }

      if (change.revoke) {
        const operators = accounts.filter((entry) => entry.capabilities.includes("operator"));
        if (change.revoke === "operator" && operators.length <= 1) {
          throw new InternalApiError(409, "last-operator");
        }

        account.capabilities = account.capabilities.filter((entry) => entry !== change.revoke);
      }

      return account;
    }
  };

  return { api, accounts, calls };
}
