// LLM-Client: Claude (Anthropic Messages API über Azure AI Foundry), nur fetch.
import { loadEnv } from "./env.mjs";

loadEnv();

const ENDPOINT =
  process.env.ANTHROPIC_ENDPOINT ||
  "https://aiditor-sweden.services.ai.azure.com/anthropic/v1/messages";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-fable-5";
const KEY = process.env.ANTHROPIC_KEY;

export function llmConfigured() {
  return Boolean(ENDPOINT && KEY && KEY !== "xx");
}

/**
 * Chat-Completion gegen Claude (Anthropic Messages API).
 * Signatur kompatibel zum bisherigen Azure-OpenAI-Client.
 * @param {Array<{role:string,content:string}>} messages
 * @param {{json?: boolean, temperature?: number}} opts
 * @returns {Promise<string>} Antworttext
 */
export async function chat(messages, opts = {}) {
  if (!llmConfigured()) {
    throw new Error("LLM nicht konfiguriert – ANTHROPIC_KEY in .env setzen.");
  }

  // Anthropic trennt system-Prompt von den Messages.
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const userMessages = messages.filter((m) => m.role !== "system");

  if (opts.json && userMessages.length) {
    const last = userMessages.length - 1;
    userMessages[last] = {
      ...userMessages[last],
      content:
        userMessages[last].content +
        "\n\nAntworte ausschließlich mit einem einzigen gültigen JSON-Objekt, ohne Markdown-Codeblock und ohne Erklärtext.",
    };
  }

  const body = {
    model: MODEL,
    max_tokens: 8000,
    messages: userMessages,
  };
  if (system) body.system = system;

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": KEY,
      "api-key": KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  let out = (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

  // Falls das Modell doch einen ```json-Block liefert: auspacken.
  if (opts.json) {
    const m = out.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) out = m[1].trim();
  }
  return out;
}
