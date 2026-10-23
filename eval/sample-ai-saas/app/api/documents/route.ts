// SEEDED VULNERABILITY (eval fixture): returns any document by id with no
// authentication and no ownership check (IDOR shape).
export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  return Response.json(await db.documents.find(id));
}
