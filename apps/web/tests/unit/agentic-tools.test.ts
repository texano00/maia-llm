import { describe, expect, it } from "vitest";
import { agenticTools } from "../../src/renderer/features/models/agentic-tools";
import { publicUrl } from "../../src/renderer/features/models/external-access";

const endpoint = {
  baseUrl: "http://117.18.102.40:30719/v1",
  modelId: "0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF",
  apiKey: "sk-run-SECRET-123"
};

describe("using a run from another tool", () => {
  it("offers the tools people actually use, each self-contained", () => {
    const tools = agenticTools(endpoint);
    const ids = tools.map((tool) => tool.id);

    expect(ids).toEqual(["continue", "cline", "copilot", "cursor", "claude-code", "curl"]);
    // Every entry is paste-ready: no placeholder left for the reader to resolve.
    for (const tool of tools) {
      expect(tool.snippet, tool.id).toBeTruthy();
      expect(tool.snippet).toContain(endpoint.apiKey);
      expect(tool.snippet).toContain(endpoint.modelId);
    }
  });

  it("puts the four facts in the right place for each tool", () => {
    const byId = new Map(agenticTools(endpoint).map((tool) => [tool.id, tool.snippet ?? ""]));

    expect(byId.get("continue")).toContain("provider: openai");
    expect(byId.get("continue")).toContain(`apiBase: ${endpoint.baseUrl}`);
    expect(byId.get("cline")).toContain("Base URL:");
    expect(byId.get("claude-code")).toContain('OPENAI_BASE_URL="http://117.18.102.40:30719/v1"');
    expect(byId.get("curl")).toContain("/chat/completions");
  });

  it("links to the server root, not the API path", () => {
    expect(publicUrl(endpoint.baseUrl)).toBe("http://117.18.102.40:30719");
    expect(publicUrl("http://host:8000/v1/")).toBe("http://host:8000");
  });
});
