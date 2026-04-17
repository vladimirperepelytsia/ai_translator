import { NextResponse } from "next/server";

const realtimeModel = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime";

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
          "Transcribe spoken English from the input audio accurately. Do not generate assistant replies.",
        output_modalities: ["text"],
        audio: {
          input: {
            transcription: {
              model: "gpt-4o-mini-transcribe",
              language: "en",
            },
            turn_detection: {
              type: "semantic_vad",
              eagerness: "low",
              create_response: false,
              interrupt_response: false,
            },
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
