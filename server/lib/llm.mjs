// Azure-OpenAI-Client (Chat Completions), ohne SDK – nur fetch.
import { loadEnv } from "./env.mjs";

loadEnv();

const ENDPOINT = process.env.AZURE_O_R_F_OPENAI_ENDPOINT;
const DEPLOYMENT = process.env.AZURE_O_R_F_OPENAI_DEPLOYMENT_NAME || "gpt-4o";
const API_VERSION =
  process.env.AZURE_O_R_F_OPENAI_API_VERSION || "2024-12-01-preview";
const KEY = process.env.AZURE_O_R_F_OPENAI_KEY;

export function llmConfigured() {
  return Boolean(ENDPOINT && KEY && KEY !== "xx");
}

/**
 * Chat-Completion gegen Azure OpenAI.
 * @param {Array<{role:string,content:string}>} messages
 * @param {{json?: boolean, temperature?: number}} opts
 * @returns {Promise<string>} Antworttext
 */
export async function chat(messages, opts = {}) {
  if (!llmConfigured()) {
    throw new Error(
      "Azure OpenAI nicht konfiguriert – AZURE_O_R_F_OPENAI_KEY in .env setzen."
    );
  }
  const url = `${ENDPOINT}/openai/deployments/${DEPLOYMENT}/chat/completions?api-version=${API_VERSION}`;
  const body = {
    messages,
    temperature: opts.temperature ?? 0.4,
    max_tokens: 4000,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Azure OpenAI HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}
