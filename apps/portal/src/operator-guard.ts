import type { FastifyRequest } from "fastify";
import { adminSessionToken } from "./auth.js";
import type { AdminAuthService } from "./services/portal-auth.js";
import { InternalApiError, type InternalAccountsApi } from "./services/internal-client.js";

export interface OperatorIdentity {
  accountId: string;
  email: string;
}

export interface OperatorGuardOptions {
  admins: AdminAuthService;
  internal: InternalAccountsApi;
  /** Injected so a test can observe refusals without a live product. */
  onRefused?: ((reason: string, email: string | null) => void) | undefined;
}

/**
 * Resolves a portal cookie to an operator.
 *
 * The capability is re-read from the product on every request, so revoking
 * `operator` takes effect on the next click rather than on the next restart. A
 * session whose operator is gone is ended immediately: leaving it in place would
 * keep a stale tab working until the cookie expired.
 */
export function createOperatorGuard(
  options: OperatorGuardOptions
): (request: FastifyRequest) => Promise<OperatorIdentity | null> {
  return async (request) => {
    const token = adminSessionToken(request);
    if (!token) {
      return null;
    }

    const session = await options.admins.sessionFor(token);
    if (!session) {
      return null;
    }

    try {
      const account = await options.internal.findAccount(session.email);
      if (!account || !account.capabilities.includes("operator")) {
        await options.admins.signOut(token);
        options.onRefused?.("not-operator", session.email);
        return null;
      }

      return { accountId: account.id, email: account.email };
    } catch (error) {
      // An unreachable product must not silently promote anybody.
      options.onRefused?.(
        error instanceof InternalApiError ? `internal:${error.code}` : "internal:error",
        session.email
      );
      return null;
    }
  };
}
