"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatSeconds,
  getPTLiveProxyUrl,
  type MediaDetails,
  type PTLiveVideoDetails,
} from "@/lib/media";

type TranslationState = "idle" | "starting" | "live" | "error";

type TranscriptJob = {
  sequence: number;
  sourceTime: number;
  text: string;
};

const MAX_ALLOWED_TRANSLATION_LAG_SECONDS = 4;

const transcriptionSessionUpdate = {
  type: "session.update",
  session: {
    type: "transcription",
    audio: {
      input: {
        turn_detection: {
          type: "semantic_vad",
          eagerness: "low",
          create_response: false,
          interrupt_response: false,
        },
        transcription: {
          model: "gpt-4o-mini-transcribe",
          language: "en",
        },
      },
    },
  },
} as const;

const translatorSessionUpdate = {
  type: "session.update",
  session: {
    type: "realtime",
    instructions:
      "Translate each provided English phrase into natural Ukrainian for live video dubbing. Respond only with the Ukrainian translation, keep it concise, and finish the full phrase before stopping.",
    output_modalities: ["audio"],
  },
} as const;

function Detail({
  label,
  value,
}: {
  label: string;
  value?: string;
}) {
  if (!value) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-white/45">{label}</p>
      <p className="mt-2 text-sm text-white/90">{value}</p>
    </div>
  );
}

function PTLiveTranslationControls({ media }: { media: PTLiveVideoDetails }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const translatedAudioRef = useRef<HTMLAudioElement>(null);
  const transcriptionPeerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const translationPeerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const transcriptionDataChannelRef = useRef<RTCDataChannel | null>(null);
  const translationDataChannelRef = useRef<RTCDataChannel | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const originalGainRef = useRef<GainNode | null>(null);
  const captureDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const translationQueueRef = useRef<TranscriptJob[]>([]);
  const activeTranslationJobRef = useRef<TranscriptJob | null>(null);
  const activeTranslationResponseIdRef = useRef<string | null>(null);
  const activeTranslatedTextRef = useRef<string | null>(null);
  const sessionVersionRef = useRef(0);
  const nextTranscriptSequenceRef = useRef(0);
  const transcriptionConnectedRef = useRef(false);
  const translationConnectedRef = useRef(false);
  const translationOutputStartedRef = useRef(false);
  const [translationState, setTranslationState] = useState<TranslationState>("idle");
  const [statusMessage, setStatusMessage] = useState(
    "Ready to start Ukrainian voice translation.",
  );
  const [transcriptHistory, setTranscriptHistory] = useState<string[]>([]);
  const [translatedHistory, setTranslatedHistory] = useState<string[]>([]);
  const [pendingTranslations, setPendingTranslations] = useState(0);

  const updatePendingTranslations = useCallback(() => {
    setPendingTranslations(
      translationQueueRef.current.length + (activeTranslationJobRef.current ? 1 : 0),
    );
  }, []);

  const setOriginalAudioMuted = useCallback((muted: boolean) => {
    if (originalGainRef.current) {
      originalGainRef.current.gain.value = muted ? 0 : 1;
    }
  }, []);

  const resetTranslatedAudio = useCallback(() => {
    if (!translatedAudioRef.current) {
      return;
    }

    translatedAudioRef.current.pause();
    translatedAudioRef.current.srcObject = null;
    translatedAudioRef.current.removeAttribute("src");
    translatedAudioRef.current.load();
  }, []);

  const stopTranslation = useCallback(() => {
    sessionVersionRef.current += 1;

    transcriptionDataChannelRef.current?.close();
    transcriptionDataChannelRef.current = null;
    translationDataChannelRef.current?.close();
    translationDataChannelRef.current = null;

    transcriptionPeerConnectionRef.current?.close();
    transcriptionPeerConnectionRef.current = null;
    translationPeerConnectionRef.current?.close();
    translationPeerConnectionRef.current = null;

    resetTranslatedAudio();
    setOriginalAudioMuted(false);

    translationQueueRef.current = [];
    activeTranslationJobRef.current = null;
    activeTranslationResponseIdRef.current = null;
    activeTranslatedTextRef.current = null;
    nextTranscriptSequenceRef.current = 0;
    transcriptionConnectedRef.current = false;
    translationConnectedRef.current = false;
    translationOutputStartedRef.current = false;
    setPendingTranslations(0);
    setTranslationState("idle");
    setStatusMessage("Translation stopped.");
  }, [resetTranslatedAudio, setOriginalAudioMuted]);

  useEffect(() => {
    return () => {
      stopTranslation();
      void audioContextRef.current?.close();
      audioContextRef.current = null;
    };
  }, [stopTranslation]);

  async function ensureAudioGraph() {
    const video = videoRef.current;

    if (!video) {
      throw new Error("The PT Live video element is not ready.");
    }

    let audioContext = audioContextRef.current;

    if (!audioContext || audioContext.state === "closed") {
      audioContext = new AudioContext();
      audioContextRef.current = audioContext;
    }

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    if (!sourceNodeRef.current || !originalGainRef.current || !captureDestinationRef.current) {
      const sourceNode = audioContext.createMediaElementSource(video);
      const originalGain = audioContext.createGain();
      const captureDestination = audioContext.createMediaStreamDestination();

      sourceNode.connect(originalGain);
      originalGain.connect(audioContext.destination);
      sourceNode.connect(captureDestination);
      originalGain.gain.value = 1;

      sourceNodeRef.current = sourceNode;
      originalGainRef.current = originalGain;
      captureDestinationRef.current = captureDestination;
    }

    if (!captureDestinationRef.current) {
      throw new Error("Could not create an audio capture destination for the PT Live video.");
    }

    return captureDestinationRef.current.stream;
  }

  function dropStaleQueuedPhrases() {
    const currentVideoTime = videoRef.current?.currentTime;

    if (typeof currentVideoTime !== "number") {
      return;
    }

    let removedAny = false;

    while (
      translationQueueRef.current.length > 0 &&
      currentVideoTime - translationQueueRef.current[0].sourceTime >
        MAX_ALLOWED_TRANSLATION_LAG_SECONDS
    ) {
      translationQueueRef.current.shift();
      removedAny = true;
    }

    if (removedAny) {
      updatePendingTranslations();
      setStatusMessage("Skipping delayed phrases to stay close to the current video.");
    }
  }

  function markLiveIfReady() {
    if (!transcriptionConnectedRef.current || !translationConnectedRef.current) {
      return;
    }

    setTranslationState("live");
    setStatusMessage(
      activeTranslationJobRef.current
        ? "Connected. Streaming Ukrainian audio for the current phrase."
        : "Connected. Waiting for the next English phrase to stream into Ukrainian.",
    );
  }

  function recordTranslatedPhrase(text: string) {
    const normalizedText = text.trim();

    if (!normalizedText || activeTranslatedTextRef.current === normalizedText) {
      return;
    }

    activeTranslatedTextRef.current = normalizedText;
    setTranslatedHistory((currentHistory) => [...currentHistory, normalizedText]);
  }

  async function submitNextTranslationJob(sessionVersion: number) {
    if (sessionVersionRef.current !== sessionVersion || activeTranslationJobRef.current) {
      return;
    }

    const translationChannel = translationDataChannelRef.current;

    if (!translationChannel || translationChannel.readyState !== "open") {
      return;
    }

    dropStaleQueuedPhrases();

    const nextJob = translationQueueRef.current.shift();
    updatePendingTranslations();

    if (!nextJob) {
      setOriginalAudioMuted(false);

      if (translationState === "live") {
        setStatusMessage("Connected. Waiting for the next English phrase to stream into Ukrainian.");
      }

      return;
    }

    activeTranslationJobRef.current = nextJob;
    activeTranslationResponseIdRef.current = null;
    activeTranslatedTextRef.current = null;
    translationOutputStartedRef.current = false;
    updatePendingTranslations();
    setStatusMessage("Streaming Ukrainian translation for the next English phrase...");

    translationChannel.send(
      JSON.stringify({
        type: "response.create",
        response: {
          conversation: "none",
          output_modalities: ["audio"],
          instructions:
            "Translate the provided English phrase into natural Ukrainian for live dubbing. Respond only with the Ukrainian translation. Keep the wording compact, and finish the full phrase before stopping.",
          metadata: {
            sequence: String(nextJob.sequence),
            source_time_seconds: nextJob.sourceTime.toFixed(2),
          },
          input: [
            {
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: nextJob.text,
                },
              ],
            },
          ],
        },
      }),
    );
  }

  function finishActiveTranslationJob(sessionVersion: number, nextStatusMessage?: string) {
    if (sessionVersionRef.current !== sessionVersion || !activeTranslationJobRef.current) {
      return;
    }

    activeTranslationJobRef.current = null;
    activeTranslationResponseIdRef.current = null;
    activeTranslatedTextRef.current = null;
    translationOutputStartedRef.current = false;
    updatePendingTranslations();
    dropStaleQueuedPhrases();

    if (translationQueueRef.current.length > 0) {
      void submitNextTranslationJob(sessionVersion);
      return;
    }

    setOriginalAudioMuted(false);

    if (translationState === "live") {
      setStatusMessage(
        nextStatusMessage ?? "Connected. Waiting for the next English phrase to stream into Ukrainian.",
      );
    }
  }

  async function requestRealtimeToken(mode: "transcription" | "translation") {
    const response = await fetch("/api/realtime/client-secret", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode }),
    });
    const payload = (await response.json()) as {
      error?: string;
      value?: string;
    };

    if (!response.ok || !payload.value) {
      throw new Error(payload.error ?? "Could not create an OpenAI Realtime session.");
    }

    return payload.value;
  }

  async function startTranslation() {
    if (translationState === "starting" || translationState === "live") {
      return;
    }

    try {
      sessionVersionRef.current += 1;
      const currentSessionVersion = sessionVersionRef.current;

      setTranslationState("starting");
      setStatusMessage("Preparing browser audio capture...");
      setTranscriptHistory([]);
      setTranslatedHistory([]);
      setPendingTranslations(0);
      translationQueueRef.current = [];
      activeTranslationJobRef.current = null;
      activeTranslationResponseIdRef.current = null;
      activeTranslatedTextRef.current = null;
      nextTranscriptSequenceRef.current = 0;
      transcriptionConnectedRef.current = false;
      translationConnectedRef.current = false;
      translationOutputStartedRef.current = false;
      setOriginalAudioMuted(false);
      resetTranslatedAudio();

      const captureStream = await ensureAudioGraph();
      const audioTrack = captureStream.getAudioTracks()[0];

      if (!audioTrack) {
        throw new Error("Could not capture the PT Live video audio track.");
      }

      setStatusMessage("Requesting OpenAI Realtime sessions...");
      const [transcriptionToken, translationToken] = await Promise.all([
        requestRealtimeToken("transcription"),
        requestRealtimeToken("translation"),
      ]);

      const transcriptionPeerConnection = new RTCPeerConnection();
      transcriptionPeerConnectionRef.current = transcriptionPeerConnection;

      transcriptionPeerConnection.onconnectionstatechange = () => {
        const state = transcriptionPeerConnection.connectionState;

        if (state === "connected") {
          transcriptionConnectedRef.current = true;
          markLiveIfReady();
        } else if (state === "failed" || state === "disconnected" || state === "closed") {
          transcriptionConnectedRef.current = false;
          stopTranslation();
        }
      };

      const transcriptionDataChannel = transcriptionPeerConnection.createDataChannel("oai-events");
      transcriptionDataChannelRef.current = transcriptionDataChannel;

      transcriptionDataChannel.addEventListener("open", () => {
        transcriptionDataChannel.send(JSON.stringify(transcriptionSessionUpdate));
      });

      transcriptionDataChannel.addEventListener("message", (event) => {
        try {
          const payload = JSON.parse(event.data) as {
            type?: string;
            transcript?: string;
          };
          const transcript = payload.transcript?.trim();

          if (
            payload.type === "conversation.item.input_audio_transcription.completed" &&
            typeof transcript === "string" &&
            transcript
          ) {
            setTranscriptHistory((currentHistory) => [...currentHistory, transcript]);
            translationQueueRef.current.push({
              sequence: nextTranscriptSequenceRef.current,
              sourceTime: videoRef.current?.currentTime ?? 0,
              text: transcript,
            });
            nextTranscriptSequenceRef.current += 1;
            updatePendingTranslations();
            dropStaleQueuedPhrases();
            void submitNextTranslationJob(currentSessionVersion);
          }
        } catch {
          // Ignore malformed realtime events.
        }
      });

      transcriptionPeerConnection.addTrack(audioTrack, captureStream);

      const translationPeerConnection = new RTCPeerConnection();
      translationPeerConnectionRef.current = translationPeerConnection;
      translationPeerConnection.addTransceiver("audio", { direction: "recvonly" });

      translationPeerConnection.ontrack = (event) => {
        if (!translatedAudioRef.current) {
          return;
        }

        translatedAudioRef.current.srcObject = event.streams[0];
      };

      translationPeerConnection.onconnectionstatechange = () => {
        const state = translationPeerConnection.connectionState;

        if (state === "connected") {
          translationConnectedRef.current = true;
          markLiveIfReady();
        } else if (state === "failed" || state === "disconnected" || state === "closed") {
          translationConnectedRef.current = false;
          stopTranslation();
        }
      };

      const translationDataChannel = translationPeerConnection.createDataChannel("oai-events");
      translationDataChannelRef.current = translationDataChannel;

      translationDataChannel.addEventListener("open", () => {
        translationDataChannel.send(JSON.stringify(translatorSessionUpdate));
        void submitNextTranslationJob(currentSessionVersion);
      });

      translationDataChannel.addEventListener("message", (event) => {
        try {
          const payload = JSON.parse(event.data) as {
            type?: string;
            text?: string;
            response_id?: string;
            response?: {
              id?: string;
              status?: string;
            };
            part?: {
              type?: string;
              text?: string;
              transcript?: string;
            };
            error?: {
              message?: string;
            };
          };

          const activeResponseId = activeTranslationResponseIdRef.current;

          if (payload.type === "error") {
            throw new Error(payload.error?.message ?? "The realtime translation session failed.");
          }

          if (payload.type === "response.created" && payload.response?.id) {
            activeTranslationResponseIdRef.current = payload.response.id;
            return;
          }

          if (payload.type === "response.output_text.done" && typeof payload.text === "string") {
            recordTranslatedPhrase(payload.text);
            return;
          }

          if (
            payload.type === "response.content_part.done" &&
            payload.part?.type === "text" &&
            typeof payload.part.text === "string"
          ) {
            recordTranslatedPhrase(payload.part.text);
            return;
          }

          if (
            payload.type === "response.content_part.done" &&
            payload.part?.type === "audio" &&
            typeof payload.part.transcript === "string"
          ) {
            recordTranslatedPhrase(payload.part.transcript);
            return;
          }

          if (
            payload.type === "output_audio_buffer.started" &&
            (!activeResponseId || payload.response_id === activeResponseId)
          ) {
            translationOutputStartedRef.current = true;
            setOriginalAudioMuted(true);
            setStatusMessage("Streaming Ukrainian audio over the live translation channel...");
            const playPromise = translatedAudioRef.current?.play();
            if (playPromise) {
              void playPromise.catch(() => {
                setStatusMessage(
                  "The translation stream is ready. Press play if the browser kept audio muted.",
                );
              });
            }
            return;
          }

          if (
            payload.type === "output_audio_buffer.stopped" &&
            (!activeResponseId || payload.response_id === activeResponseId)
          ) {
            finishActiveTranslationJob(
              currentSessionVersion,
              "Connected. Waiting for the next English phrase to stream into Ukrainian.",
            );
            return;
          }

          if (payload.type === "response.done") {
            if (payload.response?.status === "failed" || payload.response?.status === "cancelled") {
              finishActiveTranslationJob(
                currentSessionVersion,
                "The previous translation did not finish. Waiting for the next phrase.",
              );
            } else if (!translationOutputStartedRef.current) {
              finishActiveTranslationJob(
                currentSessionVersion,
                "Connected. Waiting for the next English phrase to stream into Ukrainian.",
              );
            }
          }
        } catch (error) {
          stopTranslation();
          setTranslationState("error");
          setStatusMessage(
            error instanceof Error
              ? error.message
              : "Something went wrong while streaming translation.",
          );
        }
      });

      const [transcriptionOffer, translationOffer] = await Promise.all([
        transcriptionPeerConnection.createOffer(),
        translationPeerConnection.createOffer(),
      ]);

      await Promise.all([
        transcriptionPeerConnection.setLocalDescription(transcriptionOffer),
        translationPeerConnection.setLocalDescription(translationOffer),
      ]);

      if (!transcriptionOffer.sdp || !translationOffer.sdp) {
        throw new Error("Could not create a WebRTC offer for the translation session.");
      }

      setStatusMessage("Connecting the browser to OpenAI Realtime...");
      const [transcriptionRealtimeResponse, translationRealtimeResponse] = await Promise.all([
        fetch("https://api.openai.com/v1/realtime/calls", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${transcriptionToken}`,
            "Content-Type": "application/sdp",
          },
          body: transcriptionOffer.sdp,
        }),
        fetch("https://api.openai.com/v1/realtime/calls", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${translationToken}`,
            "Content-Type": "application/sdp",
          },
          body: translationOffer.sdp,
        }),
      ]);

      if (!transcriptionRealtimeResponse.ok) {
        throw new Error(
          `OpenAI Realtime transcription connection failed (${transcriptionRealtimeResponse.status}).`,
        );
      }

      if (!translationRealtimeResponse.ok) {
        throw new Error(
          `OpenAI Realtime translation connection failed (${translationRealtimeResponse.status}).`,
        );
      }

      const [transcriptionAnswer, translationAnswer] = await Promise.all([
        transcriptionRealtimeResponse.text(),
        translationRealtimeResponse.text(),
      ]);

      await Promise.all([
        transcriptionPeerConnection.setRemoteDescription({
          type: "answer",
          sdp: transcriptionAnswer,
        }),
        translationPeerConnection.setRemoteDescription({
          type: "answer",
          sdp: translationAnswer,
        }),
      ]);

      setStatusMessage("Connected. Waiting for the first English phrase to translate.");
    } catch (error) {
      stopTranslation();
      setTranslationState("error");
      setStatusMessage(
        error instanceof Error ? error.message : "Something went wrong while starting translation.",
      );
    }
  }

  return (
    <>
      <div className="aspect-video bg-black">
        <video
          ref={videoRef}
          controls
          playsInline
          preload="metadata"
          poster={media.posterUrl}
          className="h-full w-full"
          src={getPTLiveProxyUrl(media.shareUrl)}
        >
          Your browser does not support the video tag.
        </video>
        <audio ref={translatedAudioRef} autoPlay className="hidden" />
      </div>

      <div className="border-t border-white/10 px-6 py-6 sm:px-8">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={startTranslation}
            disabled={translationState === "starting" || translationState === "live"}
            className="inline-flex rounded-2xl bg-emerald-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {translationState === "starting"
              ? "Connecting..."
              : translationState === "live"
                ? "Translation Live"
                : "Start Ukrainian Translation"}
          </button>

          <button
            type="button"
            onClick={stopTranslation}
            disabled={translationState === "idle"}
            className="inline-flex rounded-2xl border border-white/15 bg-white/5 px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Stop Translation
          </button>
        </div>

        <div className="mt-4 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white/70">
          <p>{statusMessage}</p>
          <p className="mt-2 text-white/50">
            While translation is active, the video keeps playing. English phrases are transcribed on
            one live channel and streamed back as Ukrainian speech on another. If the queue falls
            behind, older unsent phrases are skipped to stay close to the video.
          </p>
          {pendingTranslations > 0 ? (
            <p className="mt-2 text-cyan-200/80">
              Phrases waiting or streaming: {pendingTranslations}
            </p>
          ) : null}
        </div>

        {transcriptHistory.length > 0 ? (
          <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-cyan-300/80">
              Latest English Speech
            </p>
            <div className="mt-3 max-h-64 space-y-3 overflow-y-auto pr-2">
              {transcriptHistory.map((phrase, index) => (
                <div
                  key={`${index}-${phrase}`}
                  className="rounded-xl border border-white/8 bg-black/20 px-3 py-2"
                >
                  <p className="text-sm text-white/85">{phrase}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {translatedHistory.length > 0 ? (
          <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-[0.2em] text-emerald-300/80">
              Spoken Ukrainian Translation
            </p>
            <div className="mt-3 max-h-64 space-y-3 overflow-y-auto pr-2">
              {translatedHistory.map((phrase, index) => (
                <div
                  key={`${index}-${phrase}`}
                  className="rounded-xl border border-white/8 bg-black/20 px-3 py-2"
                >
                  <p className="text-sm text-white/85">{phrase}</p>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <p className="mt-4 text-xs uppercase tracking-[0.18em] text-white/35">
          Disclosure: the Ukrainian translation voice is AI-generated.
        </p>
      </div>
    </>
  );
}

export function MediaPlayer({ media }: { media: MediaDetails }) {
  return (
    <section className="overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/80 shadow-2xl shadow-black/40">
      <div className="border-b border-white/10 px-6 py-5 sm:px-8">
        <p className="text-xs uppercase tracking-[0.25em] text-cyan-300/80">Loaded Media</p>
        <h2 className="mt-2 text-2xl font-semibold text-white">{media.title}</h2>
        <p className="mt-2 text-sm text-white/60">{media.shareUrl}</p>
      </div>

      {media.kind === "ptlive" ? (
        <PTLiveTranslationControls media={media} />
      ) : (
        <>
          <div className="aspect-video bg-black">
            <iframe
              key={media.embedUrl}
              src={media.embedUrl}
              title={media.title}
              className="h-full w-full"
              referrerPolicy="strict-origin-when-cross-origin"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
            />
          </div>

          <div className="border-t border-white/10 px-6 py-6 sm:px-8">
            <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm text-amber-100">
              Live voice translation is only available for PT Live videos in this build. Embedded
              YouTube playback uses a cross-origin iframe, so the browser cannot safely capture its
              audio for realtime dubbing.
            </div>
          </div>
        </>
      )}

      <div className="grid gap-4 px-6 py-6 sm:grid-cols-2 xl:grid-cols-4 sm:px-8">
        <Detail label="Platform" value={media.kind === "ptlive" ? "PT Live" : "YouTube"} />
        {media.kind === "ptlive" ? (
          <>
            <Detail label="Created" value={media.createdAt} />
            <Detail label="Date From" value={media.dateFrom} />
            <Detail label="Date To" value={media.dateTo} />
            <Detail label="Expires On" value={media.expiresAt} />
          </>
        ) : (
          <>
            <Detail label="Video ID" value={media.videoId} />
            <Detail
              label="Start At"
              value={media.startAt ? formatSeconds(media.startAt) : undefined}
            />
          </>
        )}
      </div>
    </section>
  );
}
