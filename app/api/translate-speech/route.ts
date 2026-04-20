import { NextRequest, NextResponse } from "next/server";
import {
  isStaticAuthConfigured,
  isStaticAuthRequestAuthorized,
  shouldBypassStaticAuth,
} from "@/lib/static-auth";
import {
  buildSpeechInstructions,
  buildTextTranslationInstructions,
  getTranslationLanguageConfig,
} from "@/lib/translation-languages";

const translationModel = process.env.OPENAI_TRANSLATION_MODEL ?? "gpt-4.1-mini";
const fallbackTranslationModel = process.env.OPENAI_TRANSLATION_FALLBACK_MODEL ?? "gpt-4.1-mini";
const ttsModel = process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts";
const ttsVoice = process.env.OPENAI_TTS_VOICE ?? "marin";

export const runtime = "nodejs";

type TranslationPayload = {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  error?: {
    message?: string;
  };
};

type TranslationDebug = {
  primaryModel: string;
  primaryOutputSummary: ReturnType<typeof summarizeOutput>;
  fallbackModel?: string;
  fallbackOutputSummary?: ReturnType<typeof summarizeOutput>;
};

function extractOutputText(payload: TranslationPayload) {
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  for (const item of payload.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === "string" && content.text.trim()) {
        return content.text.trim();
      }
    }
  }

  return null;
}

function summarizeOutput(payload: TranslationPayload) {
  return (payload.output ?? []).map((item) => ({
    type: item.type ?? null,
    contentTypes: (item.content ?? []).map((content) => content.type ?? null),
    textPreview:
      (item.content ?? [])
        .map((content) => (typeof content.text === "string" ? content.text.slice(0, 80) : null))
        .filter(Boolean)[0] ?? null,
  }));
}

async function requestTranslation(
  apiKey: string,
  model: string,
  sourceText: string,
  targetLanguageLabel: string,
) {
  const requestBody: Record<string, unknown> = {
    model,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text: buildTextTranslationInstructions(targetLanguageLabel),
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: sourceText,
          },
        ],
      },
    ],
    max_output_tokens: 400,
  };

  if (model.startsWith("gpt-5")) {
    requestBody.reasoning = {
      effort: "minimal",
    };
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  const payload = (await response.json()) as TranslationPayload;

  return {
    response,
    payload,
    translatedText: extractOutputText(payload),
  };
}

export async function POST(request: NextRequest) {
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
    text?: string;
    targetLanguage?: string;
  } | null;
  const sourceText = body?.text?.trim();
  const targetLanguage = getTranslationLanguageConfig(body?.targetLanguage);

  if (!sourceText) {
    return NextResponse.json({ error: "Missing source text." }, { status: 400 });
  }

  const primaryAttempt = await requestTranslation(
    apiKey,
    translationModel,
    sourceText,
    targetLanguage.label,
  );

  if (!primaryAttempt.response.ok) {
    return NextResponse.json(
      {
        error: primaryAttempt.payload.error?.message ?? "OpenAI translation request failed.",
      },
      { status: primaryAttempt.response.status },
    );
  }

  let translatedText = primaryAttempt.translatedText;
  let translationDebug: TranslationDebug = {
    primaryModel: translationModel,
    primaryOutputSummary: summarizeOutput(primaryAttempt.payload),
  };

  if (!translatedText && fallbackTranslationModel !== translationModel) {
    const fallbackAttempt = await requestTranslation(
      apiKey,
      fallbackTranslationModel,
      sourceText,
      targetLanguage.label,
    );

    if (fallbackAttempt.response.ok) {
      translatedText = fallbackAttempt.translatedText;
      translationDebug = {
        ...translationDebug,
        fallbackModel: fallbackTranslationModel,
        fallbackOutputSummary: summarizeOutput(fallbackAttempt.payload),
      };
    }
  }

  if (!translatedText) {
    return NextResponse.json(
      {
        error: "The translation model returned no text.",
        debug: {
          ...translationDebug,
        },
      },
      { status: 502 },
    );
  }

  const speechResponse = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ttsModel,
      voice: ttsVoice,
      input: translatedText,
      response_format: "mp3",
      instructions: buildSpeechInstructions(targetLanguage.label),
    }),
  });

  if (!speechResponse.ok) {
    const errorText = await speechResponse.text();

    return NextResponse.json(
      {
        error: errorText || "OpenAI text-to-speech request failed.",
      },
      { status: speechResponse.status },
    );
  }

  const audioBase64 = Buffer.from(await speechResponse.arrayBuffer()).toString("base64");

  return NextResponse.json({
    translatedText,
    audioBase64,
    mimeType: "audio/mpeg",
  });
}
