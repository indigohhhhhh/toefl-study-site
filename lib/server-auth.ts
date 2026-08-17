export function requestUserId(request: Request): string {
  const userId = request.headers.get("oai-authenticated-user-id");
  if (userId) return userId;
  const host = new URL(request.url).hostname;
  if (host === "localhost" || host === "127.0.0.1") return "local-preview";
  throw new Error("AUTH_REQUIRED");
}
