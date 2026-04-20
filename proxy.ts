import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  buildStaticAuthRedirectPath,
  isStaticAuthConfigured,
  isStaticAuthRequestAuthorized,
  normalizeStaticAuthRedirectPath,
  shouldBypassStaticAuth,
} from "@/lib/static-auth";

function unauthorizedApiResponse() {
  return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}

function loginRedirect(request: NextRequest) {
  const loginUrl = new URL("/login", request.url);

  loginUrl.searchParams.set("next", buildStaticAuthRedirectPath(request.nextUrl));

  return NextResponse.redirect(loginUrl);
}

export async function proxy(request: NextRequest) {
  if (shouldBypassStaticAuth()) {
    return NextResponse.next();
  }

  if (!isStaticAuthConfigured()) {
    return new NextResponse("Static auth is not configured.", { status: 503 });
  }

  const pathname = request.nextUrl.pathname;
  const isLoginRoute = pathname === "/login";
  const isApiRoute = pathname.startsWith("/api/");
  const isAuthorized = await isStaticAuthRequestAuthorized(request.headers.get("cookie"));

  if (!isAuthorized) {
    if (isLoginRoute) {
      return NextResponse.next();
    }

    if (isApiRoute || (request.method !== "GET" && request.method !== "HEAD")) {
      return unauthorizedApiResponse();
    }

    return loginRedirect(request);
  }

  if (isLoginRoute) {
    const nextPath = normalizeStaticAuthRedirectPath(request.nextUrl.searchParams.get("next"));

    return NextResponse.redirect(new URL(nextPath, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt).*)"],
};
