// SEEDED VULNERABILITY (eval fixture): POST handler with no auth check that
// feeds raw user input to the model and returns raw model output.
export async function POST(req: Request) {
  const { prompt } = await req.json();
  const result = await generateText({ model: "openai/gpt-5-mini", prompt });
  return Response.json({ text: result.text });
}
