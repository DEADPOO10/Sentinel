export const protectedRoutePrefixes = ["/dashboard", "/repositories", "/settings"] as const;

export function isProtectedRoute(pathname: string) {
  return protectedRoutePrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
