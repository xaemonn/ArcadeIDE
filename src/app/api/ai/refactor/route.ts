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
        { error: "Missing code to explain" },
        { status: 400 }
      );
    }

    const prompt = `
    You are a senior software engineer tasked with reviewing and improving code quality.
    
    Refactor the following ${language || ""} code with these goals:
    - Improve readability and maintainability
    - Optimize performance (without altering behavior)
    - Simplify logic and remove any unnecessary repetition
    - Follow clean code principles and idiomatic ${language || "style"}
    
    Please keep the original code structure intact as much as possible.
    Do NOT create new helper functions or abstractions.
    Add brief comments ONLY if absolutely necessary to clarify complex sections.
    Avoid over-commenting.
    
    Output only the refactored code, without any markdown formatting or explanations.
    
    Here is the code:
    
    ${code}
    `;

    const response = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [
        { role: "system", content: "You are an expert software engineer." },
        { role: "user", content: prompt },
      ],
    });

    const result = stripCodeFences(response.choices[0].message.content || "");

    return NextResponse.json({ result });
  } catch (error) {
    return errorResponse(error, "Failed to refactor code");
  }
}
