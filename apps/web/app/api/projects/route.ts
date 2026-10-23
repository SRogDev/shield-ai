import { CreateProjectRequestSchema } from "@shield/shared";
import { errorResponse, json, requireUserId, service } from "@/lib/server";

export async function GET(req: Request): Promise<Response> {
  try {
    const userId = await requireUserId(req);
    const listing = service().listProjects(userId);
    return json({ ...listing, balance: service().balance(userId) });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const userId = await requireUserId(req);
    const body = CreateProjectRequestSchema.parse(await req.json());
    return json(service().createProject(userId, body.name), 201);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    const userId = await requireUserId(req);
    const url = new URL(req.url);
    const projectId = url.searchParams.get("projectId");
    if (!projectId) return json({ error: "projectId is required" }, 400);
    service().deleteProject(userId, projectId);
    return json({ deleted: true });
  } catch (err) {
    return errorResponse(err);
  }
}
