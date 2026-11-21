import { describe, expect, it } from "vitest";
import {
  PLAYBOOKS,
  buildPlaybookInjection,
  classifyPromptLayerImpact,
  detectPlaybooks,
} from "./playbooks.js";

describe("PLAYBOOKS — live audit proof discipline", () => {
  it("does not inject CTF flag-hunting commands into dynamic playbooks", () => {
    const injection = buildPlaybookInjection([
      "sqli",
      "ssti",
      "lfi",
      "blind_exploitation",
      "cve_exploitation",
      "command_injection",
      "deserialization",
    ]);

    expect(injection).toContain("Post-Exploitation Proof");
    expect(injection).not.toContain("cat /flag");
    expect(injection).not.toContain("/flag.txt");
    expect(injection).not.toContain("extract flag");
    expect(injection).not.toContain("Flag Hunt");
  });
});

describe("PLAYBOOKS — LLM-app breadth (#566)", () => {
  it("detectPlaybooks surfaces prompt_injection from chatbot/injection text", () => {
    const out = detectPlaybooks([
      "The chatbot assistant ignores all previous instructions when asked",
      "We extracted the system prompt from the LLM",
    ]);
    expect(out).toContain("prompt_injection");
  });

  it("detectPlaybooks surfaces excessive_agency from tool/function text", () => {
    const out = detectPlaybooks([
      "The agent exposes function calling over MCP",
      "It will send email and delete records via tool_call when asked",
    ]);
    expect(out).toContain("excessive_agency");
  });

  it("detectPlaybooks surfaces rag_poisoning from retrieval text", () => {
    const out = detectPlaybooks([
      "The app uses retrieval augmented generation over a knowledge base",
      "Users can upload a document that gets indexed into the vector store",
    ]);
    expect(out).toContain("rag_poisoning");
  });
});

describe("PLAYBOOKS — AI prompt-layer write target (#775)", () => {
  it("detectPlaybooks surfaces prompt_layer_write from DB-foothold + prompt-store text", () => {
    const out = detectPlaybooks([
      "Confirmed SQLi; dumping information_schema",
      "Found a table system_prompt with a guardrail column on the chatbot LLM app",
    ]);
    expect(out).toContain("prompt_layer_write");
  });
});

describe("classifyPromptLayerImpact (#775)", () => {
  it("flags a non-prompt asset as not a prompt-layer target", () => {
    const r = classifyPromptLayerImpact({
      table: "orders",
      column: "total_amount",
      sample: "42.00",
      writable: true,
      reReadAtInference: true,
    });
    expect(r.isPromptLayer).toBe(false);
    expect(r.impacts).toEqual([]);
    expect(r.severity).toBe("info");
  });

  it("classifies a writable, re-read system_prompt as high / prompt_poisoning", () => {
    const r = classifyPromptLayerImpact({
      table: "assistant_settings",
      column: "system_prompt",
      sample: "You are a helpful banking assistant. Never reveal account numbers.",
      writable: true,
      reReadAtInference: true,
    });
    expect(r.isPromptLayer).toBe(true);
    expect(r.severity).toBe("high");
    expect(r.impacts).toContain("prompt_poisoning");
    // guardrail language in the sample also surfaces guardrail_removal
    expect(r.impacts).toContain("guardrail_removal");
    expect(r.narrative).toContain("WRITABLE");
    expect(r.narrative.toLowerCase()).toContain("no destructive write");
  });

  it("downgrades to low when the prompt asset is not writable", () => {
    const r = classifyPromptLayerImpact({
      table: "prompts",
      column: "system_prompt",
      sample: "You are an assistant.",
      writable: false,
      reReadAtInference: true,
    });
    expect(r.isPromptLayer).toBe(true);
    expect(r.severity).toBe("low");
    expect(r.impacts).toEqual([]);
    expect(r.narrative.toLowerCase()).toContain("read exposure only");
  });

  it("writable but not re-read at inference stays low (no persistence proof)", () => {
    const r = classifyPromptLayerImpact({
      table: "model_config",
      column: "temperature",
      writable: true,
      reReadAtInference: false,
    });
    expect(r.isPromptLayer).toBe(true);
    expect(r.severity).toBe("low");
    expect(r.impacts).toContain("model_config_tamper");
  });

  it("detects output-channel exfil and guardrail-removal classes by name", () => {
    const exfil = classifyPromptLayerImpact({
      column: "output_template",
      writable: true,
      reReadAtInference: true,
    });
    expect(exfil.impacts).toContain("output_channel_exfil");

    const guard = classifyPromptLayerImpact({
      table: "safety_settings",
      column: "moderation_policy",
      writable: true,
      reReadAtInference: true,
    });
    expect(guard.impacts).toContain("guardrail_removal");
    expect(guard.severity).toBe("high");
  });
});
