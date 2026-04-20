"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  createStaticAuthSessionValue,
  getStaticAuthClearedCookieOptions,
  getStaticAuthCookieOptions,
  isStaticAuthConfigured,
  normalizeStaticAuthRedirectPath,
  shouldBypassStaticAuth,
  STATIC_AUTH_COOKIE_NAME,
  staticAuthCredentialsMatch,
} from "@/lib/static-auth";

export type LoginFormState = {
  error?: string;
  username?: string;
};

export async function loginAction(
  _: LoginFormState,
  formData: FormData,
): Promise<LoginFormState> {
  if (shouldBypassStaticAuth()) {
    redirect("/");
  }

  if (!isStaticAuthConfigured()) {
    return {
      error: "Static auth is not configured on the server.",
    };
  }

  const username = String(formData.get("username") ?? "").trim();
  const password = String(formData.get("password") ?? "");
  const nextPath = normalizeStaticAuthRedirectPath(String(formData.get("next") ?? "/"));

  if (!username || !password) {
    return {
      error: "Enter both username and password.",
      username,
    };
  }

  if (!staticAuthCredentialsMatch(username, password)) {
    return {
      error: "Invalid username or password.",
      username,
    };
  }

  const sessionValue = await createStaticAuthSessionValue();

  if (!sessionValue) {
    return {
      error: "Static auth is not configured on the server.",
      username,
    };
  }

  (await cookies()).set(STATIC_AUTH_COOKIE_NAME, sessionValue, getStaticAuthCookieOptions());

  redirect(nextPath);
}

export async function logoutAction() {
  if (shouldBypassStaticAuth()) {
    redirect("/");
  }

  if (!isStaticAuthConfigured()) {
    redirect("/");
  }

  (await cookies()).set(STATIC_AUTH_COOKIE_NAME, "", getStaticAuthClearedCookieOptions());

  redirect("/login");
}
