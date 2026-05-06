import Link from "next/link";
import { GeminiPerformanceScriptDubbingPocForm } from "@/components/gemini-performance-script-dubbing-poc-form";

export default function GeminiPerformanceScriptDubbingPocPage() {
  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#1f3b54_0%,#08111d_40%,#04070b_100%)] px-6 py-10 text-white">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <header className="flex flex-col gap-6 rounded-[2rem] border border-white/10 bg-white/6 p-8 shadow-2xl shadow-black/40 backdrop-blur lg:p-10">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-cyan-300/80">
              Gemini Performance Script POC
            </p>
            <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
              Let Gemini hear the emotion before it translates.
            </h1>
            <p className="mt-4 max-w-3xl text-base leading-7 text-white/70">
              This uses Gemini audio understanding to create a translated performance script with
              interjections, intensity, volume, and pacing, then renders it through Gemini TTS.
            </p>
          </div>

          <Link
            href="/"
            className="inline-flex w-fit rounded-2xl border border-white/15 px-5 py-3 text-sm font-semibold text-white/85 transition hover:border-cyan-300/50 hover:text-white"
          >
            Back to video translator
          </Link>
        </header>

        <GeminiPerformanceScriptDubbingPocForm />
      </div>
    </main>
  );
}
