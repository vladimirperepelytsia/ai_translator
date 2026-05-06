import { randomUUID } from "crypto";
import { mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { getTranslationLanguageConfig, type TranslationLanguage } from "@/lib/translation-languages";

const execFileAsync = promisify(execFile);

export type GeminiPerformanceScriptSegment = {
  id: number;
  start: number;
  end: number;
  sourceText: string;
  translatedText: string;
  ttsText: string;
  emotion: string;
  intensity: number;
  volume: "whisper" | "soft" | "medium" | "loud" | "shout";
  pace: "very slow" | "slow" | "medium" | "fast" | "very fast";
  nonLexical: string[];
  pauseBeforeMs: number;
  pauseAfterMs: number;
  ttsPrompt: string;
};

type GeminiPerformanceScript = {
  originalTranscript: string;
  translatedText: string;
  segments: GeminiPerformanceScriptSegment[];
};

type FlexibleGeminiScript =
  | Partial<GeminiPerformanceScript> & {
      performanceSegments?: GeminiPerformanceScriptSegment[];
      performanceScript?: GeminiPerformanceScriptSegment[];
      utterances?: GeminiPerformanceScriptSegment[];
      phrases?: GeminiPerformanceScriptSegment[];
      items?: GeminiPerformanceScriptSegment[];
      lines?: GeminiPerformanceScriptSegment[];
      script?: GeminiPerformanceScriptSegment[];
    };

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          data?: string;
          mimeType?: string;
        };
        inline_data?: {
          data?: string;
          mime_type?: string;
        };
      }>;
    };
  }>;
  error?: {
    message?: string;
  };
};

type GeminiTtsPayload = {
  model: string;
  prompt: string;
  text: string;
  speaker: string;
};

export type GeminiPerformanceScriptDubbingResult = GeminiPerformanceScript & {
  audioBuffer: Buffer;
  mimeType: "audio/mpeg";
  provider: "gemini-performance-script";
  targetLanguage: TranslationLanguage;
  models: {
    script: string;
    tts: string;
  };
  notice: string;
};

const maxAudioBytes = 25 * 1024 * 1024;
const scriptModel = process.env.GEMINI_PERFORMANCE_SCRIPT_MODEL ?? "gemini-2.5-flash";
const fallbackScriptModel =
  process.env.GEMINI_PERFORMANCE_SCRIPT_FALLBACK_MODEL ?? "gemini-2.5-flash-lite";
const ttsModel = process.env.GEMINI_PERFORMANCE_TTS_MODEL ?? "gemini-3.1-flash-tts-preview";
const ttsSpeaker = process.env.GEMINI_PERFORMANCE_TTS_SPEAKER ?? "Orus";
const ttsContext =
  process.env.GEMINI_PERFORMANCE_TTS_CONTEXT ??
  "You are performing casino entertainment audio for a live casino game show audience.";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function getNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) ? value : fallback;
}

function parseJsonObject<T>(text: string, label: string): T | null {
  const jsonText = sanitizeJsonText(text);

  try {
    return JSON.parse(jsonText) as T;
  } catch (firstError) {
    const repairedJsonText = repairTruncatedJson(jsonText);

    if (repairedJsonText) {
      try {
        return JSON.parse(repairedJsonText) as T;
      } catch {
        // Continue to structured logging below.
      }
    }

    console.error(`[gemini-performance-script-poc] Could not parse ${label} JSON.`, {
      error: firstError,
      preview: jsonText.slice(0, 800),
      length: jsonText.length,
    });
    return null;
  }
}

function sanitizeJsonText(text: string) {
  return text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .replace(/(?:\\n){6,}/g, "\\n\\n")
    .replace(/(?:\n){6,}/g, "\n\n")
    .trim();
}

function repairTruncatedJson(jsonText: string) {
  const segmentsIndex = jsonText.indexOf('"segments"');

  if (segmentsIndex === -1) {
    return null;
  }

  const segmentsArrayStart = jsonText.indexOf("[", segmentsIndex);

  if (segmentsArrayStart === -1) {
    return null;
  }

  const objectStart = jsonText.indexOf("{", segmentsArrayStart);

  if (objectStart === -1) {
    return `${jsonText.slice(0, segmentsArrayStart + 1)}]}`;
  }

  const objectEnd = findLastBalancedObjectEnd(jsonText, objectStart);

  if (objectEnd === -1) {
    return `${jsonText.slice(0, segmentsArrayStart + 1)}]}`;
  }

  return `${jsonText.slice(0, objectEnd + 1)}]}`;
}

function findLastBalancedObjectEnd(text: string, startIndex: number) {
  let depth = 0;
  let inString = false;
  let isEscaped = false;
  let lastBalancedEnd = -1;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (isEscaped) {
      isEscaped = false;
      continue;
    }

    if (char === "\\") {
      isEscaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;

      if (depth === 0) {
        lastBalancedEnd = index;
      }
    }
  }

  return lastBalancedEnd;
}

function buildFallbackScriptFromText(
  text: string,
  targetLanguageLabel: string,
  targetLanguageCode: TranslationLanguage,
) {
  const compactText = text
    .replace(/(?:\\n|\n|\s){4,}/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 3000);
  const translatedText = preserveInterjections(compactText, compactText, targetLanguageCode);

  return {
    originalTranscript: compactText,
    translatedText,
    segments: [
      {
        id: 0,
        start: 0,
        end: 0,
        sourceText: compactText,
        translatedText,
        ttsText: translatedText,
        emotion: "neutral",
        intensity: 0.5,
        volume: "loud" as const,
        pace: "medium" as const,
        nonLexical: detectSourceInterjections(compactText),
        pauseBeforeMs: 0,
        pauseAfterMs: 0,
        ttsPrompt: `Use a clear projected casino host voice. Do not whisper. Preserve emotional cues and interjections.`,
      },
    ],
  };
}

async function repairPerformanceScriptFromInvalidJson(
  apiKey: string,
  text: string,
  targetLanguageLabel: string,
  targetLanguageCode: TranslationLanguage,
) {
  const fallbackScript = buildFallbackScriptFromText(text, targetLanguageLabel, targetLanguageCode);
  const sourceText = fallbackScript.originalTranscript;

  console.info("[gemini-performance-script-poc] Requesting script repair.", {
    model: fallbackScriptModel,
    targetLanguageLabel,
  });

  const payload = await postGeminiGenerateContent(apiKey, fallbackScriptModel, {
    contents: [
      {
        parts: [
          {
            text: `Translate and rewrite this source transcript into ${targetLanguageLabel} as a faithful casino entertainment dubbing performance script.
Return strict JSON only with this exact shape: {"originalTranscript": string, "translatedText": string, "segments": array}.
Use one segment only.
The segment must include id,start,end,sourceText,translatedText,ttsText,emotion,intensity,volume,pace,nonLexical,pauseBeforeMs,pauseAfterMs,ttsPrompt.
translatedText and ttsText must contain the full translated spoken content, not a short summary.
ttsText must be translated, not source language. Include expressive inline cues like [laughs], [sigh], [breathy], [excited], [shouts] only if they fit.
Match the original delivery. Do not make it more vivid, excited, loud, fast, or dramatic than the source.
Match tone, pacing, and emphasis to the original transcript and inferred delivery. Preserve hesitation, stress, and pauses where they are implied by the source.
Default to volume "medium" and pace "medium" unless the source segment is clearly different.
Source transcript: ${sourceText}`,
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: Math.floor(getNumberEnv("GEMINI_PERFORMANCE_SCRIPT_MAX_OUTPUT_TOKENS", 8192)),
    },
  }).catch((error) => {
    console.warn("[gemini-performance-script-poc] Compact script repair failed.", {
      error: error instanceof Error ? error.message : String(error),
    });

    return null;
  });
  const repairedText = payload ? extractText(payload) : null;

  if (!repairedText) {
    return fallbackScript;
  }

  const repairedScript = parseJsonObject<FlexibleGeminiScript | GeminiPerformanceScriptSegment[]>(
    repairedText,
    "repaired performance script",
  );

  if (!repairedScript) {
    return fallbackScript;
  }

  return normalizeParsedScript(
    repairedScript,
    sourceText,
    targetLanguageLabel,
    targetLanguageCode,
  );
}

function normalizeParsedScript(
  parsedScript: FlexibleGeminiScript | GeminiPerformanceScriptSegment[],
  fallbackTranscript: string,
  targetLanguageLabel: string,
  targetLanguageCode: TranslationLanguage,
) {
  const rawSegments = getScriptSegments(parsedScript);

  if (rawSegments.length === 0) {
    console.warn("[gemini-performance-script-poc] Gemini script had no recognizable segments; wrapping it as one fallback segment.");

    return buildFallbackScriptFromText(
      fallbackTranscript,
      targetLanguageLabel,
      targetLanguageCode,
    );
  }

  const originalTranscript = Array.isArray(parsedScript)
    ? rawSegments.map((segment) => segment.sourceText).join(" ").trim() || fallbackTranscript
    : parsedScript.originalTranscript?.trim() ||
      rawSegments.map((segment) => segment.sourceText).join(" ").trim() ||
      fallbackTranscript;
  const segments = rawSegments.map((segment, index) => {
    const sourceText = segment.sourceText?.trim() || "";
    const translatedText = preserveInterjections(
      sourceText,
      segment.translatedText?.trim() || "",
      targetLanguageCode,
    );
    const ttsText = preserveInterjections(
      sourceText,
      segment.ttsText?.trim() || translatedText,
      targetLanguageCode,
    );

    return {
      ...segment,
      id: Number.isFinite(Number(segment.id)) ? Number(segment.id) : index,
      start: Number.isFinite(Number(segment.start)) ? Number(segment.start) : 0,
      end: Number.isFinite(Number(segment.end)) ? Number(segment.end) : 0,
      sourceText,
      translatedText,
      ttsText,
      emotion: segment.emotion?.trim() || "neutral",
      intensity: Math.min(1, Math.max(0, Number(segment.intensity) || 0.45)),
      volume: segment.volume || "medium",
      pace: segment.pace || "medium",
      nonLexical: [
        ...(Array.isArray(segment.nonLexical) ? segment.nonLexical : []),
        ...detectSourceInterjections(sourceText),
      ],
      pauseBeforeMs: Math.max(0, Math.min(2000, Number(segment.pauseBeforeMs) || 0)),
      pauseAfterMs: Math.max(0, Math.min(2500, Number(segment.pauseAfterMs) || 0)),
      ttsPrompt:
        segment.ttsPrompt?.trim() ||
        `Speak in natural ${targetLanguageLabel} matching the original delivery without exaggeration.`,
    };
  });
  const translatedText = Array.isArray(parsedScript)
    ? segments.map((segment) => segment.translatedText).join(" ").trim()
    : parsedScript.translatedText?.trim() ||
      segments.map((segment) => segment.translatedText).join(" ").trim();

  console.info("[gemini-performance-script-poc] Normalized performance script.", {
    segments: segments.length,
    originalTranscriptLength: originalTranscript.length,
    translatedTextLength: translatedText.length,
    sample: segments.slice(0, 5).map((segment, index) => ({
      index,
      id: segment.id,
      start: segment.start,
      end: segment.end,
      emotion: segment.emotion,
      intensity: segment.intensity,
      volume: segment.volume,
      pace: segment.pace,
      text: (segment.ttsText || segment.translatedText || segment.sourceText || "").slice(0, 80),
    })),
  });

  return {
    originalTranscript,
    translatedText,
    segments,
  };
}

function normalizeForComparison(text: string) {
  return text
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripInlineCues(text: string) {
  return text.replace(/\[[^\]]+\]/g, "").trim();
}

function isLikelyUntranslatedSegment(segment: GeminiPerformanceScriptSegment) {
  const source = normalizeForComparison(segment.sourceText);
  const translated = normalizeForComparison(stripInlineCues(segment.translatedText));
  const tts = normalizeForComparison(stripInlineCues(segment.ttsText));

  if (!source || (!translated && !tts)) {
    return false;
  }

  return source === translated || source === tts;
}

async function ensureTranslatedPerformanceScript(
  apiKey: string,
  script: GeminiPerformanceScript,
  targetLanguageLabel: string,
  targetLanguageCode: TranslationLanguage,
) {
  const untranslatedSegments = script.segments.filter(isLikelyUntranslatedSegment);

  if (untranslatedSegments.length === 0) {
    return script;
  }

  console.warn("[gemini-performance-script-poc] Repairing untranslated Gemini segments.", {
    model: fallbackScriptModel,
    untranslatedSegments: untranslatedSegments.length,
    totalSegments: script.segments.length,
    targetLanguageLabel,
  });

  const compactSegments = script.segments.map((segment) => ({
    id: segment.id,
    sourceText: segment.sourceText,
    emotion: segment.emotion,
    intensity: segment.intensity,
    volume: segment.volume,
    pace: segment.pace,
    nonLexical: segment.nonLexical,
  }));
  const payload = await postGeminiGenerateContent(apiKey, fallbackScriptModel, {
    contents: [
      {
        parts: [
          {
            text: `Repair this performance script by translating every sourceText into natural ${targetLanguageLabel}.
Return strict JSON only with this exact shape: {"originalTranscript": string, "translatedText": string, "segments": array}.
Keep the same segment ids. Do not leave translatedText or ttsText in the source language.
translatedText is clean readable ${targetLanguageLabel}.
ttsText is speakable ${targetLanguageLabel} for TTS and may include inline cues like [laughs], [sigh], [breathy], [excited], [shouts] when they fit the emotion.
Keep casino entertainment delivery: upbeat, suspenseful, amused, energetic.
Segments: ${JSON.stringify(compactSegments)}`,
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: 2400,
    },
  }).catch((error) => {
    console.warn("[gemini-performance-script-poc] Untranslated segment repair failed.", {
      error: error instanceof Error ? error.message : String(error),
    });

    return null;
  });
  const repairedText = payload ? extractText(payload) : null;

  if (!repairedText) {
    return script;
  }

  const repairedScript = parseJsonObject<FlexibleGeminiScript | GeminiPerformanceScriptSegment[]>(
    repairedText,
    "translation repair script",
  );

  if (!repairedScript) {
    return script;
  }

  return normalizeParsedScript(
    repairedScript,
    script.originalTranscript,
    targetLanguageLabel,
    targetLanguageCode,
  );
}

function extractText(response: GeminiGenerateContentResponse) {
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.text?.trim()) {
        return part.text.trim();
      }
    }
  }

  return null;
}

function extractInlineAudio(response: GeminiGenerateContentResponse) {
  for (const candidate of response.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const data = part.inlineData?.data ?? part.inline_data?.data;

      if (data) {
        return Buffer.from(data, "base64");
      }
    }
  }

  return null;
}

function getScriptSegments(script: FlexibleGeminiScript | GeminiPerformanceScriptSegment[]) {
  if (Array.isArray(script)) {
    return script;
  }

  if (Array.isArray(script.segments)) {
    return script.segments;
  }

  if (Array.isArray(script.performanceSegments)) {
    return script.performanceSegments;
  }

  if (Array.isArray(script.performanceScript)) {
    return script.performanceScript;
  }

  if (Array.isArray(script.utterances)) {
    return script.utterances;
  }

  if (Array.isArray(script.phrases)) {
    return script.phrases;
  }

  if (Array.isArray(script.items)) {
    return script.items;
  }

  if (Array.isArray(script.lines)) {
    return script.lines;
  }

  if (Array.isArray(script.script)) {
    return script.script;
  }

  return [];
}

const sourceInterjectionPatterns = [
  { key: "relieved_exhale", pattern: /(?:ф+\s*у+\s*х+|фу+х+|ух+|p+hew+|f+u+h+)/i },
  { key: "surprise_ah", pattern: /(?:а+х+|a+h+|oh+)/i },
  { key: "pain_or_alarm", pattern: /(?:о+й+|ай+|ouch|ow+)/i },
  { key: "hesitation", pattern: /(?:м+м+|м-гм|um+|uh+|hmm+)/i },
  { key: "laugh", pattern: /(?:ха+\s*ха+|хе+\s*хе+|haha+|hehe+)/i },
];

function detectSourceInterjections(text: string) {
  return sourceInterjectionPatterns
    .filter((item) => item.pattern.test(text))
    .map((item) => item.key);
}

function preserveInterjections(
  sourceText: string,
  translatedText: string,
  targetLanguageCode: TranslationLanguage,
) {
  void sourceText;
  void targetLanguageCode;

  return translatedText;
}

async function runFfmpeg(args: string[], timeoutMs = 120000) {
  await execFileAsync("ffmpeg", ["-hide_banner", "-nostdin", ...args], {
    timeout: timeoutMs,
    maxBuffer: 12 * 1024 * 1024,
  });
}

async function postGeminiGenerateContent(
  apiKey: string,
  model: string,
  body: Record<string, unknown>,
) {
  const maxAttempts = Math.max(1, Math.floor(getNumberEnv("GEMINI_PERFORMANCE_MAX_RETRIES", 3)));
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(`${GEMINI_BASE_URL}/models/${model}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => null)) as
      | GeminiGenerateContentResponse
      | null;

    if (response.ok) {
      if (!payload) {
        throw new Error("Gemini generateContent returned no payload.");
      }

      return payload;
    }

    const message = payload?.error?.message ?? "Gemini generateContent request failed.";
    lastError = new Error(message);

    if (!isRetryableGeminiError(response.status, message) || attempt === maxAttempts) {
      throw lastError;
    }

    const retryAfterMs =
      getRetryAfterMs(response.headers.get("retry-after"), message) ??
      getNumberEnv("GEMINI_PERFORMANCE_RETRY_BASE_MS", 1500) * 2 ** (attempt - 1);
    const maxRetryMs = getNumberEnv("GEMINI_PERFORMANCE_MAX_RETRY_DELAY_MS", 45000);
    const backoffMs = Math.min(retryAfterMs, maxRetryMs);

    console.warn("[gemini-performance-script-poc] Gemini request failed; retrying.", {
      model,
      attempt,
      maxAttempts,
      status: response.status,
      message,
      backoffMs,
    });

    await wait(backoffMs);
  }

  throw lastError ?? new Error("Gemini generateContent request failed.");
}

function isRetryableGeminiError(status: number, message: string) {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    /high demand|try again later|temporarily|overloaded|unavailable/i.test(message)
  );
}

function getRetryAfterMs(retryAfterHeader: string | null, message: string) {
  const retryAfterSeconds = Number(retryAfterHeader);

  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return retryAfterSeconds * 1000;
  }

  const retryInMatch = message.match(/retry in\s*([0-9.]+)s/i);
  const retryInSeconds = Number(retryInMatch?.[1]);

  if (Number.isFinite(retryInSeconds) && retryInSeconds > 0) {
    return Math.ceil(retryInSeconds * 1000);
  }

  return null;
}

function buildGeminiTtsPrompt(payload: GeminiTtsPayload) {
  return `${payload.prompt}

${payload.text}`;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function createPerformanceScript(
  apiKey: string,
  audioFile: File,
  targetLanguageLabel: string,
  targetLanguageCode: TranslationLanguage,
) {
  if (audioFile.size > maxAudioBytes) {
    throw new Error("Audio file is larger than the Gemini POC limit.");
  }

  console.info("[gemini-performance-script-poc] Requesting audio-aware performance script.", {
    model: scriptModel,
    bytes: audioFile.size,
    type: audioFile.type,
    targetLanguageLabel,
  });

  const audioBase64 = Buffer.from(await audioFile.arrayBuffer()).toString("base64");
  const prompt = `You are creating a faithful translated dubbing performance script from the attached audio.
Return strict one-line JSON only with exactly this top-level shape: {"originalTranscript": string, "translatedText": string, "segments": array}.
Never return markdown. Never return an empty segments array.
Return exactly 1 segment that covers the full spoken clip from the first speech to the last speech.
originalTranscript must be a faithful transcript of the spoken source audio, not a summary or description.
translatedText must be the full natural ${targetLanguageLabel} translation of the spoken clip, not a short summary.
ttsText must be the full speakable ${targetLanguageLabel} performance script for Gemini TTS.
Do not optimize for exact timing, original duration, or pause alignment. Optimize for a natural, emotionally faithful translated performance.

Analyze the audio directly, not only the words. Detect emotion, intensity, loudness, pace, breaths, sighs, laughter, hesitation, elongated sounds, and expressive interjections.
Match tone, pacing, and emphasis to the original audio. Preserve where the speaker speeds up, slows down, stresses a word, softens, pauses, or hesitates.
Translate into natural ${targetLanguageLabel}, but preserve the original emotional intensity exactly. Do not make it more excited, dramatic, theatrical, loud, or energetic than the original.
If the source contains sounds such as фууух/ух/ах/ой/мм/ха-ха, translatedText must include a natural speakable equivalent such as "Uf...", "¡Ah!", "¡Ay!", "Mmm...", or laughter in ${targetLanguageLabel}. Do not silently drop these sounds.

The single segment must include:
id, start, end, sourceText, translatedText, ttsText, emotion, intensity 0-1, volume one of whisper/soft/medium/loud/shout, pace one of very slow/slow/medium/fast/very fast, nonLexical array, pauseBeforeMs, pauseAfterMs, ttsPrompt.
Use start 0 and end 0 if exact timing is uncertain.
Use volume, pace, and intensity that match the original segment. Most normal speech should be medium volume and medium pace. Use loud/fast/excited only when the original audio is clearly loud/fast/excited.

translatedText is clean readable translated text.
ttsText is the exact speakable performance text for Gemini TTS. It should include inline cues when needed, for example: [laughs] I did NOT expect that. [sigh] Can you believe it!
Use cues like [laughs], [sigh], [gasps], [whispers], [excited], [breathy], [shouts] only when they match the original audio performance.
Do not add extra intro sounds, reactions, or filler that are not in the source audio.
ttsPrompt should be a concise director note for Gemini TTS under 160 characters. It must say to match the original delivery and not exaggerate.`;
  const requestBody = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: audioFile.type || "audio/mpeg",
              data: audioBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: Math.floor(getNumberEnv("GEMINI_PERFORMANCE_SCRIPT_MAX_OUTPUT_TOKENS", 8192)),
    },
  };
  const payload = await postGeminiGenerateContentWithFallback(
    apiKey,
    [scriptModel, fallbackScriptModel].filter((model, index, models) => model && models.indexOf(model) === index),
    requestBody,
    "performance script",
  );
  const scriptText = extractText(payload);

  if (!scriptText) {
    throw new Error("Gemini performance script returned no text.");
  }

  const parsedScript = parseJsonObject<FlexibleGeminiScript | GeminiPerformanceScriptSegment[]>(
    scriptText,
    "performance script",
  );

  if (!parsedScript) {
    console.warn(
      "[gemini-performance-script-poc] Repairing compact single-segment script after invalid Gemini JSON.",
    );

    return repairPerformanceScriptFromInvalidJson(
      apiKey,
      scriptText,
      targetLanguageLabel,
      targetLanguageCode,
    );
  }

  return normalizeParsedScript(
    parsedScript,
    scriptText,
    targetLanguageLabel,
    targetLanguageCode,
  );
}

async function postGeminiGenerateContentWithFallback(
  apiKey: string,
  models: string[],
  body: Record<string, unknown>,
  label: string,
) {
  let lastError: Error | null = null;

  for (const model of models) {
    try {
      return await postGeminiGenerateContent(apiKey, model, body);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(`${label} request failed.`);

      console.warn("[gemini-performance-script-poc] Gemini model attempt failed.", {
        label,
        model,
        error: lastError.message,
      });
    }
  }

  throw lastError ?? new Error(`Gemini ${label} request failed.`);
}

async function generateFullScriptSpeechPcm(
  apiKey: string,
  script: GeminiPerformanceScript,
  targetLanguageLabel: string,
) {
  console.info("[gemini-performance-script-poc] Requesting single Gemini TTS performance render.", {
    model: ttsModel,
    voice: ttsSpeaker,
    segments: script.segments.length,
  });

  const performanceLines = script.segments.map((segment, index) => ({
    line: index + 1,
    say: segment.ttsText || segment.translatedText,
    delivery: {
      emotion: segment.emotion,
      intensity: segment.intensity,
      volume: segment.volume,
      pace: segment.pace,
      pauseBeforeMs: segment.pauseBeforeMs,
      pauseAfterMs: segment.pauseAfterMs,
      nonLexical: segment.nonLexical,
      directorNotes: segment.ttsPrompt,
    },
  }));
  const ttsPayload = {
    model: ttsModel,
    prompt: `${ttsContext}
Perform this complete translated dubbing script in ${targetLanguageLabel} while matching the original audio's emotional contour.
Use the exact text content, but perform it according to delivery notes. Do not flatten real emotion, but also do not exaggerate it.
Match tone, pacing, and emphasis to the original audio as closely as Gemini TTS allows.
The delivery should remain natural for casino entertainment, but faithful to the source: same approximate calmness, hesitation, excitement, sighs, and intensity.
Do not make neutral or mildly expressive lines sound highly excited.
Preserve expressive interjections, breathy exclamations, pauses, volume changes, pacing, and emotional intensity.
Inline cues like [laughs], [sigh], [breathy], [excited], or [pause] are performance cues, not words to explain.
Use a natural clear voice. Do not whisper, do not murmur, and do not speak softly unless the original audio is clearly quiet or the text explicitly says [whispers].
Use one continuous natural synthetic voice. Do not clone or imitate the original speaker's voice.`,
    text: performanceLines
      .map((line) => `${line.say}`)
      .filter(Boolean)
      .join("\n"),
    speaker: ttsSpeaker,
  } satisfies GeminiTtsPayload;
  const payload = await postGeminiGenerateContent(apiKey, ttsModel, {
    contents: [
      {
        parts: [{ text: buildGeminiTtsPrompt(ttsPayload) }],
      },
    ],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: ttsPayload.speaker,
          },
        },
      },
    },
  });
  const audioBuffer = extractInlineAudio(payload);

  if (!audioBuffer) {
    throw new Error("Gemini TTS returned no audio.");
  }

  return audioBuffer;
}

async function convertPcmToMp3(pcmPath: string, mp3Path: string) {
  await runFfmpeg([
    "-f",
    "s16le",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-i",
    pcmPath,
    "-codec:a",
    "libmp3lame",
    "-q:a",
    "3",
    "-y",
    mp3Path,
  ]);
}

async function renderPerformanceScriptAudio(
  apiKey: string,
  script: GeminiPerformanceScript,
  targetLanguageLabel: string,
) {
  const tempDirectory = join(tmpdir(), `gemini-performance-script-render-${randomUUID()}`);
  const outputPath = join(tempDirectory, "gemini-performance-script-output.mp3");

  await mkdir(tempDirectory, { recursive: true });

  try {
    const pcmPath = join(tempDirectory, "full-script.pcm");
    const audioBuffer = await generateFullScriptSpeechPcm(apiKey, script, targetLanguageLabel);

    await writeFile(pcmPath, audioBuffer);
    await convertPcmToMp3(pcmPath, outputPath);
    return await readFile(outputPath);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

export async function dubAudioWithGeminiPerformanceScript(
  audioFile: File,
  targetLanguageValue: string | null | undefined,
) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY.");
  }

  const targetLanguage = getTranslationLanguageConfig(targetLanguageValue);
  const performanceScript = await createPerformanceScript(
    apiKey,
    audioFile,
    targetLanguage.label,
    targetLanguage.code,
  );
  const translatedPerformanceScript = await ensureTranslatedPerformanceScript(
    apiKey,
    performanceScript,
    targetLanguage.label,
    targetLanguage.code,
  );

  const audioBuffer = await renderPerformanceScriptAudio(
    apiKey,
    translatedPerformanceScript,
    targetLanguage.label,
  );

  return {
    ...translatedPerformanceScript,
    audioBuffer,
    mimeType: "audio/mpeg",
    provider: "gemini-performance-script",
    targetLanguage: targetLanguage.code,
    models: {
      script: scriptModel,
      tts: ttsModel,
    },
    notice:
      "Gemini performance-script POC: this uses Gemini audio understanding plus Gemini TTS. It aims to preserve emotion, interjections, pace, and delivery, but it does not clone or preserve the original speaker voice.",
  } satisfies GeminiPerformanceScriptDubbingResult;
}
