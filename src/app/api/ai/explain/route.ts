import { NextResponse } from "next/server";
import { errorResponse, requireUser } from "@/lib/access";
import {
  AI_MODEL,
  aiNotConfigured,
  getOpenAI,
  inputTooLarge,
  MAX_AI_INPUT_CHARS,
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
        { error: "Missing code to explain" },
        { status: 400 }
      );
    }

    const prompt = `
    You are a senior developer and a clear communicator.

    Your task is to explain the following ${
      language || ""
    } code in plain, beginner-friendly language.

    Instructions:
    - Break down what the code does in simple steps
    - Describe key parts (like functions, loops, conditions) clearly and simply
    - Avoid technical jargon unless necessary
    - Keep the tone friendly and conversational
    - Don't use markdown formatting or headings — just write a plain explanation

    Here is the code:

    ${code}
    `;

    const response = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: "system", content: "You are an expert developer assistant." },
        { role: "user", content: prompt },
      ],
    });

    const explanation = response.choices[0].message.content?.trim() || "";

    return NextResponse.json({ explanation });
  } catch (error) {
    return errorResponse(error, "Failed to generate explanation");
  }
}
