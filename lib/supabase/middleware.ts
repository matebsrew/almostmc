import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;
  const isAuthPage = pathname === "/login" || pathname === "/register";
  const isAuthCallback = pathname === "/auth/callback";
  const isApiRoute = pathname.startsWith("/api/");
  const isSelfAuthenticatedApi =
    pathname === "/api/webhooks/late" ||
    pathname === "/api/cron/jobs" ||
    pathname === "/api/cron/sequences";

  if (isAuthCallback || isSelfAuthenticatedApi) return supabaseResponse;

  if (isApiRoute && !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const redirectWithCookies = (destination: string) => {
    const url = request.nextUrl.clone();
    url.pathname = destination;
    const response = NextResponse.redirect(url);
    supabaseResponse.cookies.getAll().forEach((cookie) => response.cookies.set(cookie));
    return response;
  };

  if (pathname === "/") return redirectWithCookies(user ? "/dashboard" : "/login");
  if (user && isAuthPage) return redirectWithCookies("/dashboard");
  if (!user && (pathname === "/dashboard" || pathname.startsWith("/dashboard/"))) {
    return redirectWithCookies("/login");
  }

  return supabaseResponse;
}