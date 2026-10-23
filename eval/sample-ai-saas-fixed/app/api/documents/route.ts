export async function GET(req: Request) {
  const session = await auth();
  if (!session) return new Response("unauthorized", { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  return Response.json(await db.documents.findForUser(id, session.userId));
}
