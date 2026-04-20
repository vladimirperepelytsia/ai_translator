const STATIC_AUTH_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export const STATIC_AUTH_COOKIE_NAME = "static_auth_session";

function getStaticAuthCredentials() {
  const username = process.env.BASIC_AUTH_USERNAME?.trim();
  const password = process.env.BASIC_AUTH_PASSWORD;

  if (!username || !password) {
    return null;
  }

  return { username, password };
}

export function isStaticAuthConfigured() {
  return getStaticAuthCredentials() !== null;
}

function toBase64Url(value: string | Uint8Array) {
  const buffer = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);

  return buffer.toString("base64url");
}

function fromBase64Url(value: string) {
  return Buffer.from(value, "base64url");
}

async function getStaticAuthSigningKey() {
  const credentials = getStaticAuthCredentials();

  if (!credentials) {
    return null;
  }

  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${credentials.username}:${credentials.password}`),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign", "verify"],
  );
}

export function shouldBypassStaticAuth() {
  return process.env.NODE_ENV === "development" && !getStaticAuthCredentials();
}

export function normalizeStaticAuthRedirectPath(value: string | null | undefined) {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/login")) {
    return "/";
  }

  return value;
}

export function buildStaticAuthRedirectPath(url: Pick<URL, "pathname" | "search">) {
  return normalizeStaticAuthRedirectPath(`${url.pathname}${url.search}`);
}

export function staticAuthCredentialsMatch(username: string, password: string) {
  const credentials = getStaticAuthCredentials();

  if (!credentials) {
    return false;
  }

  return username === credentials.username && password === credentials.password;
}

export function getStaticAuthCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    expires: new Date(Date.now() + STATIC_AUTH_SESSION_TTL_SECONDS * 1000),
  };
}

export function getStaticAuthClearedCookieOptions() {
  return {
    ...getStaticAuthCookieOptions(),
    expires: new Date(0),
    maxAge: 0,
  };
}

export async function createStaticAuthSessionValue() {
  const signingKey = await getStaticAuthSigningKey();

  if (!signingKey) {
    return null;
  }

  const payload = toBase64Url(
    JSON.stringify({
      exp: Date.now() + STATIC_AUTH_SESSION_TTL_SECONDS * 1000,
    }),
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    signingKey,
    new TextEncoder().encode(payload),
  );

  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifyStaticAuthSessionValue(sessionValue: string | null | undefined) {
  const signingKey = await getStaticAuthSigningKey();

  if (!signingKey || !sessionValue) {
    return false;
  }

  const [payload, signature] = sessionValue.split(".");

  if (!payload || !signature) {
    return false;
  }

  const isValid = await crypto.subtle.verify(
    "HMAC",
    signingKey,
    fromBase64Url(signature),
    new TextEncoder().encode(payload),
  );

  if (!isValid) {
    return false;
  }

  try {
    const decodedPayload = JSON.parse(fromBase64Url(payload).toString("utf8")) as {
      exp?: number;
    };

    return typeof decodedPayload.exp === "number" && decodedPayload.exp > Date.now();
  } catch {
    return false;
  }
}

export function getStaticAuthCookieValue(cookieHeader: string | null) {
  if (!cookieHeader) {
    return null;
  }

  for (const cookie of cookieHeader.split(";")) {
    const trimmedCookie = cookie.trim();

    if (trimmedCookie.startsWith(`${STATIC_AUTH_COOKIE_NAME}=`)) {
      return trimmedCookie.slice(STATIC_AUTH_COOKIE_NAME.length + 1);
    }
  }

  return null;
}

export async function isStaticAuthRequestAuthorized(cookieHeader: string | null) {
  return verifyStaticAuthSessionValue(getStaticAuthCookieValue(cookieHeader));
}
