import { NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/access";
import {
  AI_MODEL,
  aiNotConfigured,
  getOpenAI,
  inputTooLarge,
  MAX_AI_INPUT_CHARS,
  stripCodeFences,
} from "@/lib/openai";

export async function POST(req: Request) {
  try {
    await requireUser();
    const openai = getOpenAI();
    if (!openai) return aiNotConfigured();

    const { code, language } = await req.json();
    if (typeof code === "string" && code.length > MAX_AI_INPUT_CHARS) {
      return inputTooLarge();
    }

    if (!code) {
      return NextResponse.json(
        { error: "Missing code to comment" },
        { status: 400 }
      );
    }

    const prompt = `
    You are a senior developer known for writing clean, professional, and minimal code comments.

    Your task:
    - Add comments **only above non-trivial logic**, control flow, or complex functions
    - Do **not** comment on simple operations (like return statements, variable assignments, or logging)
    - Avoid stating what the code obviously does — only add comments when it improves clarity
    - Use proper ${language || "language-specific"} comment syntax
    - Keep the code unchanged — just insert helpful comments **above relevant lines**
    - Write in clear, concise plain English

    Output only the code — no explanations, no markdown formatting, no extra wrapping.

    Here is the code:

    ${code}
    `;

    const response = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content:
            "You are a professional senior developer who writes clean and minimal comments only where necessary.",
        },
        { role: "user", content: prompt },
      ],
    });

    const result = stripCodeFences(response.choices[0].message.content || "");

    return NextResponse.json({ result });
  } catch (error) {
    return errorResponse(error, "Failed to generate comments");
  }
}
