"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatSeconds,
  getPTLiveProxyUrl,
  type MediaDetails,
  type PTLiveVideoDetails,
} from "@/lib/media";

type TranslationState = "idle" | "starting" | "live" | "error";

type TranslatedClip = {
  translatedText: string;
  audioBase64: string;
  mimeType: string;
};

const translationSessionUpdate = {
  type: "session.update",
  session: {
    instructions:
      "Transcribe spoken English from the input audio accurately. Do not generate assistant replies.",
    output_modalities: ["text"],
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

function base64ToBlob(base64: string, mimeType: string) {
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));

  return new Blob([bytes], { type: mimeType });
}

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
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const originalGainRef = useRef<GainNode | null>(null);
  const captureDestinationRef = useRef<MediaStreamAudioDestinationNode | null>(null);
  const translationQueueRef = useRef<string[]>([]);
  const playbackQueueRef = useRef<TranslatedClip[]>([]);
  const isTranslatingRef = useRef(false);
  const currentPlaybackUrlRef = useRef<string | null>(null);
  const sessionVersionRef = useRef(0);
  const [translationState, setTranslationState] = useState<TranslationState>("idle");
  const [statusMessage, setStatusMessage] = useState(
    "Ready to start Ukrainian voice translation.",
  );
  const [transcriptHistory, setTranscriptHistory] = useState<string[]>([]);
  const [translatedHistory, setTranslatedHistory] = useState<string[]>([]);
  const [pendingTranslations, setPendingTranslations] = useState(0);

  const clearPlaybackAudio = useCallback(() => {
    if (translatedAudioRef.current) {
      translatedAudioRef.current.pause();
      translatedAudioRef.current.srcObject = null;
      translatedAudioRef.current.removeAttribute("src");
      translatedAudioRef.current.load();
      translatedAudioRef.current.onended = null;
    }

    if (currentPlaybackUrlRef.current) {
      URL.revokeObjectURL(currentPlaybackUrlRef.current);
      currentPlaybackUrlRef.current = null;
    }
  }, []);

  const stopTranslation = useCallback(() => {
    sessionVersionRef.current += 1;

    dataChannelRef.current?.close();
    dataChannelRef.current = null;

    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;

    clearPlaybackAudio();

    if (originalGainRef.current) {
      originalGainRef.current.gain.value = 1;
    }

    translationQueueRef.current = [];
    playbackQueueRef.current = [];
    isTranslatingRef.current = false;
    setPendingTranslations(0);
    setTranslationState("idle");
    setStatusMessage("Translation stopped.");
  }, [clearPlaybackAudio]);

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

  async function playNextClip() {
    const translatedAudio = translatedAudioRef.current;
    const nextClip = playbackQueueRef.current.shift();

    if (!translatedAudio || !nextClip) {
      if (translationState === "live") {
        setStatusMessage("Listening for the next English phrase...");
      }
      return;
    }

    clearPlaybackAudio();

    const clipUrl = URL.createObjectURL(base64ToBlob(nextClip.audioBase64, nextClip.mimeType));
    currentPlaybackUrlRef.current = clipUrl;
    translatedAudio.src = clipUrl;
    translatedAudio.onended = () => {
      void playNextClip();
    };

    setTranslatedHistory((currentHistory) => [...currentHistory, nextClip.translatedText]);
    setStatusMessage("Playing the full Ukrainian phrase...");

    try {
      await translatedAudio.play();
    } catch {
      setStatusMessage("Translated audio is ready. Press play if the browser kept audio muted.");
    }
  }

  async function processTranslationQueue(sessionVersion: number) {
    if (isTranslatingRef.current) {
      return;
    }

    isTranslatingRef.current = true;

    while (translationQueueRef.current.length > 0 && sessionVersionRef.current === sessionVersion) {
      const englishPhrase = translationQueueRef.current.shift();

      if (!englishPhrase) {
        continue;
      }

      setPendingTranslations(translationQueueRef.current.length);
      setStatusMessage("Translating the next English phrase into Ukrainian...");

      try {
        const response = await fetch("/api/translate-speech", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: englishPhrase,
          }),
        });
        const payload = (await response.json()) as {
          error?: string;
          translatedText?: string;
          audioBase64?: string;
          mimeType?: string;
        };

        if (!response.ok || !payload.audioBase64 || !payload.translatedText || !payload.mimeType) {
          throw new Error(payload.error ?? "Could not translate and synthesize the phrase.");
        }

        if (sessionVersionRef.current !== sessionVersion) {
          break;
        }

        playbackQueueRef.current.push({
          translatedText: payload.translatedText,
          audioBase64: payload.audioBase64,
          mimeType: payload.mimeType,
        });

        if (translatedAudioRef.current?.paused ?? true) {
          await playNextClip();
        }
      } catch (error) {
        setTranslationState("error");
        setStatusMessage(
          error instanceof Error
            ? error.message
            : "Something went wrong while translating the phrase.",
        );
        break;
      }
    }

    isTranslatingRef.current = false;
    setPendingTranslations(translationQueueRef.current.length);
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
      playbackQueueRef.current = [];
      clearPlaybackAudio();

      const captureStream = await ensureAudioGraph();
      const audioTrack = captureStream.getAudioTracks()[0];

      if (!audioTrack) {
        throw new Error("Could not capture the PT Live video audio track.");
      }

      setStatusMessage("Requesting an OpenAI Realtime transcription session...");
      const tokenResponse = await fetch("/api/realtime/client-secret", {
        method: "POST",
      });
      const tokenPayload = (await tokenResponse.json()) as {
        error?: string;
        value?: string;
      };

      if (!tokenResponse.ok || !tokenPayload.value) {
        throw new Error(tokenPayload.error ?? "Could not create an OpenAI Realtime session.");
      }

      const peerConnection = new RTCPeerConnection();
      peerConnectionRef.current = peerConnection;

      peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;

        if (state === "connected") {
          setTranslationState("live");
          setStatusMessage("Listening to English audio and queuing full Ukrainian phrases.");
          if (originalGainRef.current) {
            originalGainRef.current.gain.value = 0;
          }
        } else if (state === "failed" || state === "disconnected" || state === "closed") {
          stopTranslation();
        }
      };

      const dataChannel = peerConnection.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;

      dataChannel.addEventListener("open", () => {
        dataChannel.send(JSON.stringify(translationSessionUpdate));
      });

      dataChannel.addEventListener("message", (event) => {
        try {
          const payload = JSON.parse(event.data) as {
            type?: string;
            transcript?: string;
          };
          const transcript = payload.transcript;

          if (
            payload.type === "conversation.item.input_audio_transcription.completed" &&
            typeof transcript === "string"
          ) {
            setTranscriptHistory((currentHistory) => [...currentHistory, transcript]);
            translationQueueRef.current.push(transcript);
            setPendingTranslations(translationQueueRef.current.length);
            void processTranslationQueue(currentSessionVersion);
          }
        } catch {
          // Ignore malformed realtime events.
        }
      });

      peerConnection.addTrack(audioTrack, captureStream);

      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);

      if (!offer.sdp) {
        throw new Error("Could not create a WebRTC offer for the translation session.");
      }

      setStatusMessage("Connecting the browser to OpenAI Realtime...");
      const realtimeResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokenPayload.value}`,
          "Content-Type": "application/sdp",
        },
        body: offer.sdp,
      });

      if (!realtimeResponse.ok) {
        throw new Error(`OpenAI Realtime connection failed (${realtimeResponse.status}).`);
      }

      await peerConnection.setRemoteDescription({
        type: "answer",
        sdp: await realtimeResponse.text(),
      });

      setStatusMessage(
        "Connected. Start or resume the video. English phrases will be translated and spoken in order.",
      );
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
            While translation is active, the original English audio is muted. Each detected English
            phrase is translated, synthesized, and played to completion in Ukrainian.
          </p>
          {pendingTranslations > 0 ? (
            <p className="mt-2 text-cyan-200/80">
              Pending phrases in queue: {pendingTranslations}
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
