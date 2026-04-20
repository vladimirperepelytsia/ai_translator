import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import {
  normalizeStaticAuthRedirectPath,
  shouldBypassStaticAuth,
  STATIC_AUTH_COOKIE_NAME,
  verifyStaticAuthSessionValue,
} from "@/lib/static-auth";

type LoginPageProps = {
  searchParams: Promise<{
    next?: string | string[];
  }>;
};

function getSingleValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const nextPath = normalizeStaticAuthRedirectPath(getSingleValue((await searchParams).next));

  if (shouldBypassStaticAuth()) {
    redirect("/");
  }

  const sessionValue = (await cookies()).get(STATIC_AUTH_COOKIE_NAME)?.value;

  if (await verifyStaticAuthSessionValue(sessionValue)) {
    redirect(nextPath);
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#1f3b54_0%,#08111d_40%,#04070b_100%)] px-6 py-10 text-white">
      <div className="mx-auto flex min-h-[calc(100vh-5rem)] w-full max-w-md items-center">
        <section className="w-full overflow-hidden rounded-[2rem] border border-white/10 bg-white/6 p-8 shadow-2xl shadow-black/40 backdrop-blur lg:p-10">
          <div>
            <LoginForm nextPath={nextPath} />
          </div>
        </section>
      </div>
    </main>
  );
}
