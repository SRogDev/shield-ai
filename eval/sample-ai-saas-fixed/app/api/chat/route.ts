export async function POST(req: Request) {
  const session = await auth();
  if (!session) return new Response("unauthorized", { status: 401 });
  const { prompt } = await req.json();
  const result = await generateText({ model: "openai/gpt-5-mini", prompt });
  return Response.json({ text: result.text });
}
