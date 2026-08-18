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
import {
  checkJavaScript,
  checkPython,
  checkCOrCpp,
  checkJava,
  type CodeCheckResult,
} from "@/lib/codeCheckers";

export async function POST(req: Request) {
  try {
    await requireUser();
    const openai = getOpenAI();
    if (!openai) return aiNotConfigured();

    const { code, language, error } = await req.json();
    if (typeof code === "string" && code.length > MAX_AI_INPUT_CHARS) {
      return inputTooLarge();
    }

    if (!code || !error) {
      return NextResponse.json(
        { error: "Missing code or error to fix" },
        { status: 400 }
      );
    }

    // The checks only give the model context; they never block a fix.
    let checkResult: CodeCheckResult = { ok: true, issues: [] };

    switch (language) {
      case "javascript":
      case "typescript":
      case "node":
        checkResult = checkJavaScript(code);
        break;
      case "python":
        checkResult = checkPython(code);
        break;
      case "c":
      case "cpp":
        checkResult = checkCOrCpp(code);
        break;
      case "java":
        checkResult = checkJava(code);
        break;
    }

    const prompt = `
    You are an experienced ${language || ""} developer and debugging assistant.

    The code was executed in a sandbox that blocks process spawning and network access.
    Static checks flagged: ${checkResult.issues.join("; ") || "nothing"}.

    The code produced this runtime error:
    ${String(error).slice(0, 5000)}

    Please carefully read the code and the error message before making any changes.

    Your task:
    - Identify and fix the issue causing the error
    - Preserve the original code’s intent and structure as much as possible
    - Make only the minimal necessary changes to fix the error

    Instructions:
    - Return only the fixed code as plain text (no explanations, comments, or markdown formatting)
    - Use correct syntax and style for ${language || "the language"}

    Here is the code:

    ${code}
    `;

    const response = await openai.chat.completions.create({
      model: AI_MODEL,
      messages: [{ role: "user", content: prompt }],
    });

    const result = stripCodeFences(response.choices[0].message.content || "");

    return NextResponse.json({ result });
  } catch (error) {
    return errorResponse(error, "Failed to fix the code");
  }
}
