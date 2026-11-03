import { GoogleGenAI } from "@google/genai";

const DEFAULT_MODEL = "gemini-3.8-flash";

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is missing. Add it to .env as GEMINI_API_KEY=your-key.",
    );
  }

  const model = process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
  const client = new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model,
    contents: "Reply with exactly: Gemini connection successful.",
  });

  if (!response.text) {
    throw new Error("Gemini returned no text response.");
  }

  console.log(`Connected to ${model}`);
  console.log(response.text);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Gemini connectivity test failed: ${message}`);
  process.exitCode = 1;
});
