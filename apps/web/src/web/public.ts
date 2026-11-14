import { z } from "zod";
import { authRequestCodeSchema, authVerifyCodeSchema } from "@maia/contracts";
import { IpcRegistry } from "../main/ipc/registry";
import type { AccessService } from "../main/services/accounts/service";

export interface PublicRegistryOptions {
  /** Release version shown in the build-info panel. */
  version: string;
}

/**
 * Channels that must answer before a session exists. Everything that touches
 * account data is registered on the per-account runtime instead, so a missing
 * cookie can never reach a repository.
 */
export function createPublicRegistry(
  access: AccessService,
  options: PublicRegistryOptions
): IpcRegistry {
  const registry = new IpcRegistry();

  registry.register("app.info", z.unknown(), () => ({
    app: "web",
    version: options.version,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    channel: "stable" as const,
    packaged: false
  }));

  registry.register("auth.config", z.unknown(), () => access.config());

  registry.register("auth.state", z.unknown(), (_payload, context) =>
    access.state(context.sessionToken ?? null)
  );

  registry.register("auth.requestCode", authRequestCodeSchema, (payload, context) =>
    access.requestCode(payload, {
      sourceAddress: context.sourceAddress ?? "-",
      userAgent: context.userAgent ?? null
    })
  );

  registry.register("auth.verifyCode", authVerifyCodeSchema, async (payload, context) => {
    const verified = await access.verifyCode(payload, {
      sourceAddress: context.sourceAddress ?? "-",
      userAgent: context.userAgent ?? null
    });

    // The token goes into the HttpOnly cookie, never into the response body.
    context.setSessionCookie?.(verified.token, verified.expiresAt);
    return verified.result;
  });

  registry.register("auth.signOut", z.unknown(), (_payload, context) => {
    const result = access.signOut(context.sessionToken ?? null);
    context.clearSessionCookie?.();
    return result;
  });

  return registry;
}
