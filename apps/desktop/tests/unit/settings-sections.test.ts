import { describe, expect, it } from "vitest";
import {
  initialExpanded,
  isExpanded,
  sectionForError,
  toggleSection
} from "../../src/renderer/features/settings/sections";

describe("settings sections", () => {
  it("starts fully collapsed", () => {
    expect(initialExpanded()).toEqual([]);
  });

  it("opens the section that holds an error", () => {
    expect(initialExpanded("gpu")).toEqual(["gpu"]);
  });

  it("expands one section without touching another", () => {
    const afterFirst = toggleSection([], "vastai");
    const afterSecond = toggleSection(afterFirst, "gpu");

    expect(isExpanded(afterSecond, "vastai")).toBe(true);
    expect(isExpanded(afterSecond, "gpu")).toBe(true);
    expect(isExpanded(afterSecond, "usage")).toBe(false);
  });

  it("collapses a section again on a second toggle", () => {
    const open = toggleSection([], "diagnostics");
    expect(toggleSection(open, "diagnostics")).toEqual([]);
  });

  it("maps a validation message to the section that must open", () => {
    expect(sectionForError("GPU startup retries must be a whole number between 0 and 10.")).toBe("gpu");
    expect(sectionForError("The wallet warning threshold must be a positive amount in USD.")).toBe("gpu");
    expect(sectionForError("Enter an http:// or https:// URL")).toBe("diagnostics");
    expect(sectionForError("Hugging Face rejected the token.")).toBe("huggingface");
    expect(sectionForError("vast.ai rejected the API key.")).toBe("vastai");
    expect(sectionForError("Something else")).toBeNull();
    expect(sectionForError(null)).toBeNull();
  });
});
