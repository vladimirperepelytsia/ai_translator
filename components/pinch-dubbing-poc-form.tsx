"use client";

import { FormEvent, useEffect, useState } from "react";
import { TRANSLATION_LANGUAGE_OPTIONS } from "@/lib/translation-languages";

type PinchJob = {
  job_id?: string;
  status?: string;
  source_lang?: string;
  target_lang?: string;
  input_duration_sec?: number;
  cost_usd?: number;
  output_expires_at?: string;
};

type PocResponse = {
  audioUrl?: string;
  enhancedAudioUrl?: string;
  overlayEvents?: Array<{
    start: number;
    end: number;
    duration: number;
    audioUrl?: string;
  }>;
  overlaySkippedReason?: string;
  provider?: string;
  targetLanguage?: string;
  job?: PinchJob;
  notice?: string;
  error?: string;
};

function formatDuration(seconds: number | null) {
  if (seconds === null || !Number.isFinite(seconds)) {
    return "unknown";
  }

  return `${seconds.toFixed(2)}s`;
}

export function PinchDubbingPocForm() {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<PocResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [originalAudioUrl, setOriginalAudioUrl] = useState<string | null>(null);
  const [originalDuration, setOriginalDuration] = useState<number | null>(null);
  const [outputDuration, setOutputDuration] = useState<number | null>(null);
  const [enhancedDuration, setEnhancedDuration] = useState<number | null>(null);

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
    setEnhancedDuration(null);

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
    setEnhancedDuration(null);

    const formData = new FormData(event.currentTarget);

    try {
      const response = await fetch("/api/pinch-dubbing-poc", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json().catch(() => null)) as PocResponse | null;

      if (!response.ok) {
        throw new Error(payload?.error ?? "Pinch dubbing request failed.");
      }

      setResult(payload);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Something went wrong.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
      <form
        onSubmit={handleSubmit}
        className="space-y-5 rounded-[2rem] border border-white/10 bg-white/6 p-6 shadow-2xl shadow-black/30 backdrop-blur"
      >
        <label className="block">
          <span className="mb-2 block text-sm font-medium text-white/80">Audio file</span>
          <input
            type="file"
            name="audio"
            accept="audio/*,video/*"
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
          {isSubmitting ? "Dubbing with Pinch..." : "Dub audio-to-audio with Pinch"}
        </button>

        <p className="text-sm leading-6 text-white/55">
          Pinch jobs usually take 2-5 minutes for 1 minute of input. This POC waits for completion
          and then stores the returned output locally.
        </p>

        {error ? (
          <p className="rounded-2xl border border-rose-400/25 bg-rose-500/10 p-4 text-sm text-rose-100">
            {error}
          </p>
        ) : null}
      </form>

      <section className="rounded-[2rem] border border-white/10 bg-white/6 p-6 shadow-2xl shadow-black/30 backdrop-blur">
        <div className="space-y-5">
          <div className="grid gap-4 xl:grid-cols-3">
            <AudioPanel
              title="Original"
              src={originalAudioUrl}
              duration={originalDuration}
              onDuration={setOriginalDuration}
            />
            <AudioPanel
              title="Pinch output"
              src={result?.audioUrl ?? null}
              duration={outputDuration}
              onDuration={setOutputDuration}
            />
            <AudioPanel
              title="Enhanced output"
              src={result?.enhancedAudioUrl ?? null}
              duration={enhancedDuration}
              onDuration={setEnhancedDuration}
            />
          </div>

          <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.25em] text-cyan-200/80">
              Duration comparison
            </p>
            <p className="mt-3 text-sm leading-6 text-white/75">
              Original: {formatDuration(originalDuration)} · Output: {formatDuration(outputDuration)}
              {" "}
              · Enhanced: {formatDuration(enhancedDuration)}
            </p>
          </div>

          {result ? (
            <>
              <ResultBlock title="Provider" value={result.provider} />
              <ResultBlock title="Job ID" value={result.job?.job_id} />
              <ResultBlock title="Status" value={result.job?.status} />
              <ResultBlock
                title="Expressive overlay events"
                value={
                  result.overlayEvents?.length
                    ? result.overlayEvents
                        .map(
                          (event) =>
                            `${event.start.toFixed(2)}s-${event.end.toFixed(
                              2,
                            )}s (${event.duration.toFixed(2)}s)`,
                        )
                        .join("\n")
                    : result.overlaySkippedReason
                }
              />
              {result.overlayEvents?.length ? (
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.25em] text-cyan-200/80">
                    Event snippets
                  </p>
                  <div className="mt-4 space-y-4">
                    {result.overlayEvents.map((event, index) => (
                      <div
                        key={`${event.start}-${event.end}`}
                        className="rounded-xl border border-white/10 bg-black/20 p-3"
                      >
                        <p className="text-xs text-white/55">
                          Event {index + 1}: {event.start.toFixed(2)}s-{event.end.toFixed(2)}s
                        </p>
                        {event.audioUrl ? (
                          <audio controls src={event.audioUrl} className="mt-2 w-full">
                            <track kind="captions" />
                          </audio>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              <ResultBlock
                title="Input duration reported by Pinch"
                value={
                  typeof result.job?.input_duration_sec === "number"
                    ? `${result.job.input_duration_sec.toFixed(2)}s`
                    : undefined
                }
              />
              <ResultBlock
                title="Estimated cost"
                value={
                  typeof result.job?.cost_usd === "number"
                    ? `$${result.job.cost_usd.toFixed(2)}`
                    : undefined
                }
              />
              <ResultBlock title="Notice" value={result.notice} />
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
