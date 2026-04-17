"use client";

import { useEffect, useRef, useState } from "react";
import {
  formatSeconds,
  getPTLiveProxyUrl,
  type MediaDetails,
  type PTLiveVideoDetails,
} from "@/lib/media";

type TranslationState = "idle" | "starting" | "live" | "error";

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
  const [translationState, setTranslationState] = useState<TranslationState>("idle");
  const [statusMessage, setStatusMessage] = useState(
    "Ready to start Ukrainian voice translation.",
  );
  const [transcriptHistory, setTranscriptHistory] = useState<string[]>([]);

  useEffect(() => {
    return () => {
      stopTranslation();
      void audioContextRef.current?.close();
      audioContextRef.current = null;
    };
  }, []);

  function stopTranslation() {
    dataChannelRef.current?.close();
    dataChannelRef.current = null;

    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;

    if (translatedAudioRef.current) {
      translatedAudioRef.current.pause();
      translatedAudioRef.current.srcObject = null;
    }

    if (originalGainRef.current) {
      originalGainRef.current.gain.value = 1;
    }

    setTranslationState("idle");
    setStatusMessage("Translation stopped.");
  }

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

  async function startTranslation() {
    if (translationState === "starting" || translationState === "live") {
      return;
    }

    try {
      setTranslationState("starting");
      setStatusMessage("Preparing browser audio capture...");

      const captureStream = await ensureAudioGraph();
      const audioTrack = captureStream.getAudioTracks()[0];

      if (!audioTrack) {
        throw new Error("Could not capture the PT Live video audio track.");
      }

      setStatusMessage("Requesting an OpenAI Realtime session...");
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

      peerConnection.ontrack = (event) => {
        if (!translatedAudioRef.current) {
          return;
        }

        translatedAudioRef.current.srcObject = event.streams[0];
        void translatedAudioRef.current.play().catch(() => {
          setStatusMessage("Translation connected. Press play if the translated audio stays muted.");
        });
      };

      peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;

        if (state === "connected") {
          setTranslationState("live");
          setStatusMessage("Live Ukrainian voice translation is active.");
          if (originalGainRef.current) {
            originalGainRef.current.gain.value = 0;
          }
        } else if (state === "failed" || state === "disconnected" || state === "closed") {
          stopTranslation();
        }
      };

      const dataChannel = peerConnection.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;

      dataChannel.addEventListener("message", (event) => {
        try {
          const payload = JSON.parse(event.data) as {
            type?: string;
            transcript?: string;
          };

          if (
            payload.type === "conversation.item.input_audio_transcription.completed" &&
            typeof payload.transcript === "string"
          ) {
            setTranscriptHistory((currentHistory) => [...currentHistory, payload.transcript]);
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

      setStatusMessage("Connected. Start or resume the video to hear Ukrainian translation.");
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
            While translation is active, the original English audio is muted and replaced with an
            AI-generated Ukrainian voice.
          </p>
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
