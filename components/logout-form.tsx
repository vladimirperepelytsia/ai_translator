import { logoutAction } from "@/app/login/actions";

export function LogoutForm() {
  return (
    <form action={logoutAction}>
      <button
        type="submit"
        className="inline-flex rounded-full border border-white/15 bg-black/20 px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] text-white/80 transition hover:border-cyan-300/60 hover:text-white"
      >
        Log out
      </button>
    </form>
  );
}
