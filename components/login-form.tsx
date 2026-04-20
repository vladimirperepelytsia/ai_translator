"use client";

import { useActionState } from "react";
import { loginAction, type LoginFormState } from "@/app/login/actions";

const initialState: LoginFormState = {};

export function LoginForm({ nextPath }: { nextPath: string }) {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="next" value={nextPath} />

      <label className="block">
        <span className="mb-2 block text-sm font-medium text-white/80">Username</span>
        <input
          type="text"
          name="username"
          defaultValue={state.username ?? ""}
          autoComplete="username"
          className="w-full rounded-2xl border border-white/15 bg-black/20 px-4 py-3 text-sm text-white outline-none ring-0 placeholder:text-white/35 focus:border-cyan-300/60"
        />
      </label>

      <label className="block">
        <span className="mb-2 block text-sm font-medium text-white/80">Password</span>
        <input
          type="password"
          name="password"
          autoComplete="current-password"
          className="w-full rounded-2xl border border-white/15 bg-black/20 px-4 py-3 text-sm text-white outline-none ring-0 placeholder:text-white/35 focus:border-cyan-300/60"
        />
      </label>

      {state.error ? (
        <p aria-live="polite" className="rounded-2xl border border-rose-400/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="inline-flex rounded-2xl bg-cyan-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-wait disabled:opacity-70"
      >
        {pending ? "Signing in..." : "Sign in"}
      </button>
    </form>
  );
}
