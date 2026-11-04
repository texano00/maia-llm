import { integrationEnableSchema } from "@maia/contracts";
import { z } from "zod";
import type { LocalEndpointService } from "../services/local-endpoint/lifecycle";
import type { IpcRegistry } from "./registry";

export interface IntegrationHandlersOptions {
  registry: IpcRegistry;
  endpoint: LocalEndpointService;
}

/**
 * The IDE endpoint is controlled through its own channels rather than
 * `settings.update`, because enabling it also has to bind (or release) a port and
 * report the port that was actually obtained.
 */
export function registerIntegrationHandlers(options: IntegrationHandlersOptions): void {
  const { registry, endpoint } = options;

  registry.register("integration.status", z.unknown(), () => endpoint.status());
  registry.register("integration.enable", integrationEnableSchema, (payload) =>
    endpoint.enable(payload.port)
  );
  registry.register("integration.disable", z.unknown(), () => endpoint.disable());
}
