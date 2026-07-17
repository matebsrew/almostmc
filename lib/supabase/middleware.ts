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
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  let {
    data: { user },
  } = await supabase.auth.getUser();

  const pathname = request.nextUrl.pathname;

  const isAuthPage = pathname === "/login" || pathname === "/register";
  const isAuthCallback = pathname === "/auth/callback";
  const isDashboard = pathname.startsWith("/dashboard");
  const isApiRoute = pathname.startsWith("/api/");

  // Auth callback and API routes (including webhooks) always pass through
  if (isAuthCallback || isApiRoute) {
    return supabaseResponse;
  }

  // Single-Tenant Auto-Login: if not authenticated, sign in as default admin
  if (!user) {
    const { data: signInData } = await supabase.auth.signInWithPassword({
      email: "heidi@zernflow.com",
      password: "ZernFlowAdmin2026!",
    });
    if (signInData.user) {
      user = signInData.user;
    }
  }

  // If visiting root or auth page, redirect to /dashboard
  if (pathname === "/" || isAuthPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    const redirectResponse = NextResponse.redirect(url);
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      redirectResponse.cookies.set(cookie.name, cookie.value);
    });
    return redirectResponse;
  }

  return supabaseResponse;
}
