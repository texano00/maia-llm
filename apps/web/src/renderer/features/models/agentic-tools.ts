import type { SessionEndpoint } from "@maia/contracts";

/**
 * How to point a real tool at a run, in the tool's own words.
 *
 * The panel used to offer one generic JSON blob labelled "Continue/Cline", which
 * fits neither exactly: each editor asks for the same four facts in a different
 * place, and a person who has to translate loses the run's remaining minutes. Every
 * entry here is the smallest complete instruction that works.
 *
 * All of them use the same four values: base URL (ending in `/v1`), model id, API
 * key, and nothing else. The key belongs to this run and dies with it.
 */
export interface AgenticTool {
  id: string;
  title: string;
  /** What to do, in order; empty when the snippet says everything. */
  steps: string[];
  /** Paste-ready text, or null when the steps are the whole instruction. */
  snippet: string | null;
  language: string;
  /** One line about what the tool is, so the list is choosable. */
  blurb: string;
}

function modelName(endpoint: SessionEndpoint): string {
  return endpoint.modelId.split("/").at(-1) ?? endpoint.modelId;
}

export function agenticTools(endpoint: SessionEndpoint): AgenticTool[] {
  const name = modelName(endpoint);

  return [
    {
      id: "continue",
      title: "VS Code · Continue",
      blurb: "The open-source assistant panel and autocomplete extension.",
      steps: ["Save this as `~/.continue/config.yaml`, then reload the VS Code window."],
      language: "yaml",
      snippet: [
        "models:",
        `  - name: Maia ${name}`,
        "    provider: openai",
        `    model: ${endpoint.modelId}`,
        `    apiBase: ${endpoint.baseUrl}`,
        `    apiKey: ${endpoint.apiKey}`,
        "    roles:",
        "      - chat",
        "      - edit"
      ].join("\n")
    },
    {
      id: "cline",
      title: "VS Code · Cline / Roo Code",
      blurb: "Agentic extensions that read and write files in your workspace.",
      steps: [
        "Open the extension settings and choose the **OpenAI Compatible** provider.",
        "Fill the four fields exactly as below, then pick the model from the list."
      ],
      language: "text",
      snippet: [
        `Base URL: ${endpoint.baseUrl}`,
        `API Key:  ${endpoint.apiKey}`,
        `Model ID: ${endpoint.modelId}`,
        "Context:  32768 (or whatever this run advertises)"
      ].join("\n")
    },
    {
      id: "copilot",
      title: "VS Code · GitHub Copilot Chat (BYOK)",
      blurb: "Copilot's own model picker, pointed at a custom OpenAI-compatible server.",
      steps: [
        "In the Copilot Chat model picker choose **Manage Models → OpenAI**.",
        "Paste the base URL and key below; Copilot then lists the run as a model."
      ],
      language: "text",
      snippet: [
        `Base URL: ${endpoint.baseUrl}`,
        `API Key:  ${endpoint.apiKey}`,
        `Model:    ${endpoint.modelId}`
      ].join("\n")
    },
    {
      id: "cursor",
      title: "Cursor",
      blurb: "Cursor's own models panel, with a custom OpenAI endpoint.",
      steps: [
        "Settings → Models → **OpenAI API Key**, and paste the key.",
        "Enable **Override OpenAI Base URL** and paste the base URL.",
        "Add the model id under *Add model*."
      ],
      language: "text",
      snippet: [
        `Base URL: ${endpoint.baseUrl}`,
        `API Key:  ${endpoint.apiKey}`,
        `Model:    ${endpoint.modelId}`
      ].join("\n")
    },
    {
      id: "claude-code",
      title: "Claude Code / aider / any OpenAI-compatible CLI",
      blurb: "Anything that reads OPENAI_BASE_URL and OPENAI_API_KEY.",
      steps: ["Export these in the shell you run the tool from."],
      language: "bash",
      snippet: [
        `export OPENAI_BASE_URL="${endpoint.baseUrl}"`,
        `export OPENAI_API_KEY="${endpoint.apiKey}"`,
        `export OPENAI_MODEL="${endpoint.modelId}"`
      ].join("\n")
    },
    {
      id: "curl",
      title: "Plain HTTP (curl)",
      blurb: "The smallest request that proves the run answers.",
      steps: [],
      language: "bash",
      snippet: [
        `curl -s ${endpoint.baseUrl}/chat/completions \\`,
        `  -H "authorization: Bearer ${endpoint.apiKey}" \\`,
        '  -H "content-type: application/json" \\',
        `  -d '{"model":"${endpoint.modelId}","messages":[{"role":"user","content":"Hello"}]}'`
      ].join("\n")
    }
  ];
}
