import type { SessionEndpoint } from "@maia/contracts";

/**
 * The three values a tool needs to reach a running model. The key is generated
 * per run and dies with it, so these snippets are only useful while the session
 * is serving.
 */
export type ExternalEndpoint = SessionEndpoint;

/** Shows enough to recognise the key, never enough to use it. */
export function maskKey(apiKey: string): string {
  if (apiKey.length <= 8) {
    return "•••";
  }

  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}

/** A request the user can paste into a terminal as-is. */
export function buildOpenAiRequest(endpoint: ExternalEndpoint): string {
  const body = JSON.stringify({
    model: endpoint.modelId,
    messages: [{ role: "user", content: "Hello from my own tool." }]
  });

  return [
    `curl -s ${endpoint.baseUrl}/chat/completions \\`,
    `  -H "authorization: Bearer ${endpoint.apiKey}" \\`,
    `  -H "content-type: application/json" \\`,
    `  -d '${body}'`
  ].join("\n");
}

/**
 * A Continue/Cline-style model entry. Deliberately plain JSON so it can be
 * pasted into any editor that speaks the OpenAI protocol.
 */
export function buildEditorConfig(endpoint: ExternalEndpoint): string {
  return JSON.stringify(
    {
      models: [
        {
          title: `Maia · ${endpoint.modelId.split("/").at(-1) ?? endpoint.modelId}`,
          provider: "openai",
          model: endpoint.modelId,
          apiBase: endpoint.baseUrl,
          apiKey: endpoint.apiKey
        }
      ]
    },
    null,
    2
  );
}

/**
 * The address a person can open in a browser.
 *
 * `endpoint.baseUrl` ends in `/v1` because that is what an OpenAI-compatible client
 * needs; the server's own root is what a browser should visit.
 */
export function publicUrl(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, "");
}
