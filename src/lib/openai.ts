import OpenAI from "openai";
import { NextResponse } from "next/server";

export const AI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
export const MAX_AI_INPUT_CHARS = 20_000;

let client: OpenAI | null = null;

/**
 * Created lazily so builds and non-AI routes work without an API key.
 * OPENAI_BASE_URL points it at any OpenAI-compatible provider (Gemini, Groq,
 * OpenRouter, a local Ollama, ...) together with a matching OPENAI_MODEL.
 */
export function getOpenAI(): OpenAI | null {
  if (!process.env.OPENAI_API_KEY) return null;
  client ??= new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  });
  return client;
}

export function aiNotConfigured() {
  return NextResponse.json(
    { error: "AI features are not configured on this server (OPENAI_API_KEY is missing)." },
    { status: 503 }
  );
}

/** Models sometimes wrap code in ``` fences despite being told not to. */
export function stripCodeFences(text: string): string {
  const match = text.trim().match(/^```[\w+-]*\n([\s\S]*?)\n?```$/);
  return match ? match[1] : text.trim();
}

export function inputTooLarge() {
  return NextResponse.json(
    { error: `Selection is too large for the AI assistant (max ${MAX_AI_INPUT_CHARS} characters).` },
    { status: 413 }
  );
}
