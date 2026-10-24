import { CreateProjectRequestSchema } from "@shield/shared";
import { errorResponse, json, requireUserId, service } from "@/lib/server";

export async function GET(req: Request): Promise<Response> {
  try {
    const userId = await requireUserId(req);
    return json(service().listProjects(userId));
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
