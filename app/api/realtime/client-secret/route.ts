import { NextResponse } from "next/server";

const realtimeModel = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime";
const realtimeVoice = process.env.OPENAI_REALTIME_VOICE ?? "marin";

export const runtime = "nodejs";

export async function POST() {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      {
        error: "Missing OPENAI_API_KEY. Set it on the server before starting live translation.",
      },
      { status: 503 },
    );
  }

  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      expires_after: {
        anchor: "created_at",
        seconds: 60,
      },
      session: {
        type: "realtime",
        model: realtimeModel,
        instructions:
          "You are a live interpreter for video playback. Listen to spoken English audio and respond only with a natural spoken Ukrainian translation. Keep pace with the source audio, do not explain what you are doing, do not answer side questions, and stay silent during non-speech or when the source is not English.",
        audio: {
          input: {
            transcription: {
              model: "gpt-4o-mini-transcribe",
              language: "en",
            },
            turn_detection: {
              type: "server_vad",
              threshold: 0.45,
              prefix_padding_ms: 250,
              silence_duration_ms: 500,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            voice: realtimeVoice,
          },
        },
      },
    }),
  });

  const data = (await response.json()) as {
    error?: {
      message?: string;
    };
    value?: string;
    client_secret?: {
      value?: string;
      expires_at?: number;
    };
  };

  if (!response.ok) {
    return NextResponse.json(
      {
        error: data.error?.message ?? "OpenAI rejected the realtime session request.",
      },
      { status: response.status },
    );
  }

  return NextResponse.json({
    value: data.client_secret?.value ?? data.value,
    expiresAt: data.client_secret?.expires_at,
  });
}
