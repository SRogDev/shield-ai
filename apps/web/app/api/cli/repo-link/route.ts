import { errorResponse, json, requireUserId, serverEnv, service } from "@/lib/server";
import { RepoLinkRequestSchema } from "@shield/shared";

export async function POST(req: Request): Promise<Response> {
  try {
    const userId = await requireUserId(req);
    const body = RepoLinkRequestSchema.parse(await req.json());
    service().linkRepo(userId, body.projectId, body.repoName, body.remoteUrlHash);
    return json({ ok: true });
  } catch (err) {
    return errorResponse(err);
  }
}
