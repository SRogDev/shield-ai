export async function GET(req: Request) {
  const session = await auth();
  if (!session) return new Response("unauthorized", { status: 401 });
  return Response.json(await db.profiles.find(session.userId));
}
