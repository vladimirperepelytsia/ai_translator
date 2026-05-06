import Link from "next/link";
import { PinchDubbingPocForm } from "@/components/pinch-dubbing-poc-form";

export default function PinchDubbingPocPage() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#1f3b54_0%,#08111d_40%,#04070b_100%)] px-6 py-10 text-white">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-6 rounded-[2rem] border border-white/10 bg-white/6 p-8 shadow-2xl shadow-black/40 backdrop-blur lg:p-10">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-cyan-300/80">
              Pinch Dubbing POC
            </p>
            <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              Dub audio directly from source speech to translated speech.
            </h1>
            <p className="mt-4 max-w-3xl text-base leading-7 text-white/70">
              This uses Pinch&apos;s asynchronous Dubbing API: upload media, create a dubbing job,
              poll for completion, then compare original and dubbed output side by side.
            </p>
          </div>

          <Link
            href="/"
            className="inline-flex w-fit rounded-2xl border border-white/15 px-5 py-3 text-sm font-semibold text-white/85 transition hover:border-cyan-300/50 hover:text-white"
          >
            Back to video translator
          </Link>
        </header>

        <PinchDubbingPocForm />
      </div>
    </main>
  );
}
