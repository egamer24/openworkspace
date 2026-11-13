export function cloudflareClientIp(request: Request) {
  const value = request.headers.get("cf-connecting-ip")?.trim();

  return value || null;
}
