import { NextResponse } from "next/server";
import {
  isStaticAuthConfigured,
  isStaticAuthRequestAuthorized,
  shouldBypassStaticAuth,
} from "@/lib/static-auth";
import {
  buildRealtimeTranslationSessionInstructions,
  getTranslationLanguageConfig,
} from "@/lib/translation-languages";

const realtimeModel = process.env.OPENAI_REALTIME_MODEL ?? "gpt-realtime";
const realtimeVoice =
  process.env.OPENAI_REALTIME_VOICE ?? process.env.OPENAI_TTS_VOICE ?? "marin";

export const runtime = "nodejs";

type RealtimeMode = "transcription" | "translation";

function getSessionConfig(mode: RealtimeMode, targetLanguageLabel: string) {
  if (mode === "translation") {
    return {
      type: "realtime",
      model: realtimeModel,
      instructions: buildRealtimeTranslationSessionInstructions(targetLanguageLabel),
      output_modalities: ["audio"],
      audio: {
        output: {
          voice: realtimeVoice,
          speed: 1.08,
        },
      },
    };
  }

  return {
    type: "transcription",
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
  };
}

export async function POST(request: Request) {
  if (!shouldBypassStaticAuth() && !isStaticAuthConfigured()) {
    return NextResponse.json({ error: "Static auth is not configured." }, { status: 503 });
  }

  if (
    !shouldBypassStaticAuth() &&
    !(await isStaticAuthRequestAuthorized(request.headers.get("cookie")))
  ) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      {
        error: "Missing OPENAI_API_KEY. Set it on the server before starting live translation.",
      },
      { status: 503 },
    );
  }

  const body = (await request.json().catch(() => null)) as {
    mode?: string;
    targetLanguage?: string;
  } | null;
  const mode = body?.mode === "translation" ? "translation" : "transcription";
  const targetLanguage = getTranslationLanguageConfig(body?.targetLanguage);

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
      session: getSessionConfig(mode, targetLanguage.label),
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
