"use client";

import { FormEvent, useEffect, useState } from "react";
import { TRANSLATION_LANGUAGE_OPTIONS } from "@/lib/translation-languages";

type PerformanceSegment = {
  id: number;
  start: number;
  end: number;
  sourceText: string;
  translatedText: string;
  ttsText: string;
  emotion: string;
  intensity: number;
  volume: string;
  pace: string;
  nonLexical: string[];
  pauseBeforeMs: number;
  pauseAfterMs: number;
  ttsPrompt: string;
};

type PocResponse = {
  originalTranscript?: string;
  translatedText?: string;
  segments?: PerformanceSegment[];
  audioUrl?: string;
  provider?: string;
  targetLanguage?: string;
  durationAlignment?: {
    enabled: boolean;
    mode?: string;
    originalDurationSeconds?: number;
    rawOutputDurationSeconds?: number;
    finalOutputDurationSeconds?: number;
    speedRatio?: number;
    segmentCount?: number;
  };
  models?: {
    script?: string;
    tts?: string;
  };
  notice?: string;
  error?: string;
};

function formatDuration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) {
    return "unknown";
  }

  return `${seconds.toFixed(2)}s`;
}

export function GeminiPerformanceScriptDubbingPocForm() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<PocResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [originalAudioUrl, setOriginalAudioUrl] = useState<string | null>(null);
  const [originalDuration, setOriginalDuration] = useState<number | null>(null);
  const [outputDuration, setOutputDuration] = useState<number | null>(null);

  useEffect(() => {
    return () => {
      if (originalAudioUrl) {
        URL.revokeObjectURL(originalAudioUrl);
      }
    };
  }, [originalAudioUrl]);

  function handleFileChange(event: FormEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null;

    setResult(null);
    setError(null);
    setOriginalDuration(null);
    setOutputDuration(null);

    if (originalAudioUrl) {
      URL.revokeObjectURL(originalAudioUrl);
    }

    setOriginalAudioUrl(file ? URL.createObjectURL(file) : null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setResult(null);
    setError(null);
    setOutputDuration(null);

    const formData = new FormData(event.currentTarget);

    try {
      const response = await fetch("/api/gemini-performance-script-dubbing-poc", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json().catch(() => null)) as PocResponse | null;

      if (!response.ok) {
        throw new Error(payload?.error ?? "Gemini performance-script request failed.");
      }

      setResult(payload);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Something went wrong.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
      <form
        onSubmit={handleSubmit}
        className="space-y-5 rounded-[2rem] border border-white/10 bg-white/6 p-6 shadow-2xl shadow-black/30 backdrop-blur"
      >
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-white/80">Audio file</span>
          <input
            type="file"
            name="audio"
            accept="audio/*"
            required
            onChange={handleFileChange}
            className="block w-full rounded-2xl border border-white/15 bg-black/20 px-4 py-3 text-sm text-white file:mr-4 file:rounded-xl file:border-0 file:bg-cyan-300 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-slate-950 focus:border-cyan-300/60"
          />
        </label>

        <label className="block">
          <span className="mb-2 block text-sm font-medium text-white/80">Target language</span>
          <select
            name="targetLanguage"
            defaultValue="es"
            className="w-full rounded-2xl border border-white/15 bg-black/20 px-4 py-3 text-sm text-white outline-none focus:border-cyan-300/60"
          >
            {TRANSLATION_LANGUAGE_OPTIONS.map((language) => (
              <option key={language.value} value={language.value} className="bg-slate-950">
                {language.label}
              </option>
            ))}
          </select>
        </label>

        <button
          type="submit"
          disabled={isSubmitting}
          className="inline-flex w-full justify-center rounded-2xl bg-cyan-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:bg-white/20 disabled:text-white/50"
        >
          {isSubmitting ? "Building Gemini performance dub..." : "Generate Gemini performance dub"}
        </button>

        <p className="text-sm leading-6 text-white/55">
          This POC asks Gemini to understand the source audio directly, generate an emotional
          translated performance script with timed reply slots, then render each reply into its
          matching original slot.
        </p>

        {error ? (
          <p className="rounded-2xl border border-rose-400/25 bg-rose-500/10 p-4 text-sm text-rose-100">
            {error}
          </p>
        ) : null}
      </form>

      <section className="rounded-[2rem] border border-white/10 bg-white/6 p-6 shadow-2xl shadow-black/30 backdrop-blur">
        <div className="space-y-5">
          <div className="grid gap-4 xl:grid-cols-2">
            <AudioPanel
              title="Original"
              src={originalAudioUrl}
              duration={originalDuration}
              onDuration={setOriginalDuration}
            />
            <AudioPanel
              title="Gemini performance output"
              src={result?.audioUrl ?? null}
              duration={outputDuration}
              onDuration={setOutputDuration}
            />
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-cyan-200/80">
              Duration comparison
            </p>
            <p className="mt-3 text-sm leading-6 text-white/75">
              Original: {formatDuration(originalDuration)} · Output: {formatDuration(outputDuration)}
            </p>
            {result?.durationAlignment ? (
              <p className="mt-2 text-xs leading-5 text-white/50">
                Server fit: {result.durationAlignment.mode ?? "unknown"} · final{" "}
                {formatDuration(result.durationAlignment.finalOutputDurationSeconds ?? null)} ·
                segments {result.durationAlignment.segmentCount ?? "n/a"}
              </p>
            ) : null}
          </div>

          {result ? (
            <>
              <ResultBlock title="Original transcript" value={result.originalTranscript} />
              <ResultBlock title="Translated text" value={result.translatedText} />
              <ResultBlock
                title="Models"
                value={[
                  `script: ${result.models?.script ?? "unknown"}`,
                  `tts: ${result.models?.tts ?? "unknown"}`,
                ].join("\n")}
              />
              <ResultBlock title="Notice" value={result.notice} />
              {result.segments?.length ? (
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.25em] text-cyan-200/80">
                    Gemini performance segments
                  </p>
                  <div className="mt-4 space-y-4">
                    {result.segments.map((segment) => (
                      <div
                        key={segment.id}
                        className="rounded-xl border border-white/10 bg-black/25 p-4"
                      >
                        <p className="text-xs text-white/45">
                          {segment.start.toFixed(2)}s-{segment.end.toFixed(2)}s ·{" "}
                          {segment.emotion} · intensity {segment.intensity.toFixed(2)} ·{" "}
                          {segment.volume} · {segment.pace}
                        </p>
                        <p className="mt-3 text-sm leading-6 text-white/70">
                          {segment.sourceText}
                        </p>
                        <p className="mt-2 text-sm leading-6 text-cyan-100">
                          {segment.translatedText}
                        </p>
                        {segment.ttsText ? (
                          <p className="mt-2 text-sm leading-6 text-emerald-100">
                            {segment.ttsText}
                          </p>
                        ) : null}
                        <p className="mt-2 text-xs leading-5 text-white/50">
                          {segment.ttsPrompt}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function AudioPanel({
  title,
  src,
  duration,
  onDuration,
}: {
  title: string;
  src: string | null;
  duration: number | null;
  onDuration: (duration: number | null) => void;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.25em] text-cyan-200/80">{title}</p>
      {src ? (
        <audio
          controls
          src={src}
          className="mt-3 w-full"
          onLoadedMetadata={(event) => onDuration(event.currentTarget.duration)}
        >
          <track kind="captions" />
        </audio>
      ) : (
        <div className="mt-3 flex h-14 items-center text-sm text-white/45">No audio yet.</div>
      )}
      <p className="mt-3 text-xs text-white/45">Duration: {formatDuration(duration)}</p>
    </div>
  );
}

function ResultBlock({ title, value }: { title: string; value?: string }) {
  if (!value) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.25em] text-cyan-200/80">{title}</p>
      <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-white/75">{value}</p>
    </div>
  );
}
