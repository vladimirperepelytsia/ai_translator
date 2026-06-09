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

type DurationAlignmentDiagnostics = {
  enabled: boolean;
  mode?: "single-take" | "segment-slots";
  originalDurationSeconds?: number;
  rawOutputDurationSeconds?: number;
  finalOutputDurationSeconds?: number;
  speedRatio?: number;
  segmentCount?: number;
  segments?: Array<{
    id: number;
    start: number;
    end: number;
    slotSeconds: number;
    rawTtsSeconds: number;
    finalSegmentSeconds: number;
    speedApplied: number;
    clipped: boolean;
    overrunSeconds?: number;
    effectiveSlotSeconds?: number;
    borrowedPauseBeforeSeconds?: number;
    borrowedPauseAfterSeconds?: number;
    silent?: boolean;
    ttsFailed?: boolean;
  }>;
};

export type GeminiPerformanceScriptDubbingResult = GeminiPerformanceScript & {
  audioBuffer: Buffer;
  mimeType: "audio/mpeg";
  provider: "gemini-performance-script";
  targetLanguage: TranslationLanguage;
  durationAlignment?: DurationAlignmentDiagnostics;
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
const ttsSpeaker = process.env.GEMINI_PERFORMANCE_TTS_SPEAKER ?? "Charon";
const ttsContext =
  process.env.GEMINI_PERFORMANCE_TTS_CONTEXT ??
  "You are performing casino entertainment audio for a live casino game show audience.";
const maxScriptSegments = Math.max(
  2,
  Math.floor(getNumberEnv("GEMINI_PERFORMANCE_MAX_SEGMENTS", 12)),
);
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

function getMinTimelineCoverageRatio() {
  return Math.min(
    0.98,
    Math.max(0.5, getNumberEnv("GEMINI_PERFORMANCE_MIN_TIMELINE_COVERAGE", 0.85)),
  );
}

function getScriptChunkSeconds() {
  return Math.max(30, getNumberEnv("GEMINI_PERFORMANCE_SCRIPT_CHUNK_SECONDS", 60));
}

function getMinScriptChunkSeconds() {
  return Math.max(15, getNumberEnv("GEMINI_PERFORMANCE_MIN_SCRIPT_CHUNK_SECONDS", 30));
}

function getMinTtsSlotSeconds() {
  return Math.max(0.8, getNumberEnv("GEMINI_PERFORMANCE_MIN_TTS_SLOT_SECONDS", 1.6));
}

function getTinySegmentMergeGapSeconds() {
  return Math.max(0.1, getNumberEnv("GEMINI_PERFORMANCE_TINY_SEGMENT_MERGE_GAP_SECONDS", 1));
}

function getTargetSegmentSpeedUp() {
  return Math.max(1, getNumberEnv("GEMINI_PERFORMANCE_TARGET_SEGMENT_SPEED_UP", 1.35));
}

function getMaxPauseBorrowRatio() {
  return Math.min(1, Math.max(0, getNumberEnv("GEMINI_PERFORMANCE_MAX_PAUSE_BORROW_RATIO", 1)));
}

function getMaxPauseBorrowSeconds() {
  return Math.max(0, getNumberEnv("GEMINI_PERFORMANCE_MAX_PAUSE_BORROW_SECONDS", 4));
}

function getMinRemainingPauseSeconds() {
  return Math.max(0, getNumberEnv("GEMINI_PERFORMANCE_MIN_REMAINING_PAUSE_SECONDS", 0));
}

function getNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) ? value : fallback;
}

function roundSeconds(value: number) {
  return Math.round(value * 1000) / 1000;
}

function normalizeTtsEmotion(emotion: string) {
  const normalizedEmotion = emotion.toLowerCase();

  if (/excited|celebrat|congrat|upbeat|announce|jackpot|win|loud|fast/.test(normalizedEmotion)) {
    return "confident upbeat casino presenter";
  }

  if (/amused|lighthearted|playful|approving|positive/.test(normalizedEmotion)) {
    return "warm amused casino presenter";
  }

  if (/curious|expectant|anticipat|inquiring|mysterious/.test(normalizedEmotion)) {
    return "confident curious casino presenter";
  }

  if (/thought|reflect|recall|hesitat|resigned|casual|procedural|neutral|confirm/.test(normalizedEmotion)) {
    return "steady confident casino presenter";
  }

  return "confident casino entertainment presenter";
}

function normalizeTtsIntensity(intensity: number) {
  if (!Number.isFinite(intensity)) {
    return 0.68;
  }

  return Math.min(0.78, Math.max(0.62, intensity));
}

function normalizeTtsPace(pace: string) {
  const normalizedPace = pace.toLowerCase();

  if (/very fast|fast/.test(normalizedPace)) {
    return "medium-fast";
  }

  return "medium";
}

function normalizeTtsVolume(volume: string) {
  const normalizedVolume = volume.toLowerCase();

  if (/shout|loud/.test(normalizedVolume)) {
    return "projected medium-loud";
  }

  return "projected medium";
}

function buildTtsDirectorNote(segment: GeminiPerformanceScriptSegment) {
  return [
    segment.ttsPrompt,
    "Perform as a confident live casino entertainment presenter.",
    "Sound warm, controlled, and present; never scared, timid, shaky, whispery, or anxious.",
    "Do not overact or dramatize. Keep it like a professional game-show host.",
  ].join(" ");
}

function hasSpeakableText(segment: GeminiPerformanceScriptSegment) {
  return Boolean(stripInlineCues(segment.ttsText || segment.translatedText || "").trim());
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
        emotion: "engaged casino host",
        intensity: 0.7,
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
Use 2-${maxScriptSegments} natural reply segments when possible.
The segment must include id,start,end,sourceText,translatedText,ttsText,emotion,intensity,volume,pace,nonLexical,pauseBeforeMs,pauseAfterMs,ttsPrompt.
translatedText and ttsText must contain the full translated spoken content, not a short summary.
ttsText must be translated, not source language. Include expressive inline cues like [laughs], [sigh], [breathy], [excited], [shouts] only if they fit.
Infer noticeable pauses from the source delivery and include them in ttsText as natural pause cues such as [pause 700], [pause 1200], or [long pause 1800]. Do not mark micro-pauses or every breath.
Use casino entertainment host delivery as the context: clear, present, lightly upbeat, and projected.
Do not use generic emotion "conversational" for host patter. Prefer labels like "engaged casino host", "upbeat", "amused", "announcing", or "excited" when they match the source.
Use intensity 0.65-0.8 for normal lively casino host delivery. Use intensity 1.0 only for clear shouting or peak excitement in the source.
Match the original delivery. Do not make it more dramatic than the source.
Match tone, pacing, and emphasis to the original transcript and inferred delivery. Preserve hesitation, stress, and pauses where they are implied by the source.
Use start/end timestamps in seconds, not milliseconds, and keep real gaps between replies.
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
  const normalizedSegments = rawSegments.map((segment, index) => {
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
  const segments = mergeStandaloneInterjectionSegments(normalizedSegments);
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

function normalizeCueText(text: string) {
  return text
    .replace(/\[[^\]]*laugh[^\]]*\]/gi, "")
    .replace(/\[[^\]]*giggle[^\]]*\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isStandaloneInterjectionSegment(segment: GeminiPerformanceScriptSegment) {
  const text = [segment.sourceText, segment.translatedText, segment.ttsText]
    .join(" ")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  const duration = Number(segment.end) - Number(segment.start);

  return (
    duration <= 1.6 &&
    words.length <= 4 &&
    /\b(whoof|hoof|oof|uff|uf|ugh|ah|oh|ay|ai|mm|mmm|eh|uh)\b/i.test(text)
  );
}

function mergeTextParts(first: string, second: string) {
  return [normalizeCueText(first), normalizeCueText(second)].filter(Boolean).join(" ");
}

function mergeStandaloneInterjectionSegments(segments: GeminiPerformanceScriptSegment[]) {
  const mergedSegments: GeminiPerformanceScriptSegment[] = [];
  let index = 0;

  while (index < segments.length) {
    const currentSegment = segments[index];
    const nextSegment = segments[index + 1];

    if (nextSegment && isStandaloneInterjectionSegment(currentSegment)) {
      const gapSeconds = Math.max(0, Number(nextSegment.start) - Number(currentSegment.end));

      if (gapSeconds <= 0.5) {
        const mergedSegment = {
          ...nextSegment,
          id: currentSegment.id,
          start: currentSegment.start,
          sourceText: mergeTextParts(currentSegment.sourceText, nextSegment.sourceText),
          translatedText: mergeTextParts(currentSegment.translatedText, nextSegment.translatedText),
          ttsText: mergeTextParts(currentSegment.ttsText, nextSegment.ttsText),
          emotion: nextSegment.emotion,
          intensity: Math.max(currentSegment.intensity, nextSegment.intensity),
          volume: nextSegment.volume,
          pace: nextSegment.pace,
          nonLexical: [...currentSegment.nonLexical, ...nextSegment.nonLexical],
          pauseBeforeMs: currentSegment.pauseBeforeMs,
          ttsPrompt: `${nextSegment.ttsPrompt} Include the opening exhale/interjection as a voiced breath, not laughter.`,
        };

        console.info("[gemini-performance-script-poc] Merged standalone interjection into following segment.", {
          interjectionId: currentSegment.id,
          nextId: nextSegment.id,
          gapSeconds: roundSeconds(gapSeconds),
          mergedStart: mergedSegment.start,
          mergedEnd: mergedSegment.end,
          text: mergedSegment.ttsText.slice(0, 100),
        });

        mergedSegments.push(mergedSegment);
        index += 2;
        continue;
      }
    }

    mergedSegments.push({
      ...currentSegment,
      ttsText: isStandaloneInterjectionSegment(currentSegment)
        ? normalizeCueText(currentSegment.ttsText)
        : currentSegment.ttsText,
      ttsPrompt: isStandaloneInterjectionSegment(currentSegment)
        ? `${currentSegment.ttsPrompt} Perform as an exhale/interjection, not laughter.`
        : currentSegment.ttsPrompt,
    });
    index += 1;
  }

  return mergedSegments;
}

function getSegmentDuration(segment: GeminiPerformanceScriptSegment) {
  return Number(segment.end) - Number(segment.start);
}

function getSegmentGap(leftSegment: GeminiPerformanceScriptSegment, rightSegment: GeminiPerformanceScriptSegment) {
  return Math.max(0, Number(rightSegment.start) - Number(leftSegment.end));
}

function isTinyTtsSegment(segment: GeminiPerformanceScriptSegment) {
  const duration = Number(segment.end) - Number(segment.start);
  const text = stripInlineCues(segment.ttsText || segment.translatedText || segment.sourceText);

  return duration > 0 && duration < getMinTtsSlotSeconds() && text.length <= 120;
}

function mergeAdjacentSegments(
  firstSegment: GeminiPerformanceScriptSegment,
  secondSegment: GeminiPerformanceScriptSegment,
  note: string,
) {
  return {
    ...secondSegment,
    id: firstSegment.id,
    start: firstSegment.start,
    sourceText: mergeTextParts(firstSegment.sourceText, secondSegment.sourceText),
    translatedText: mergeTextParts(firstSegment.translatedText, secondSegment.translatedText),
    ttsText: mergeTextParts(firstSegment.ttsText, secondSegment.ttsText),
    intensity: Math.max(firstSegment.intensity, secondSegment.intensity),
    nonLexical: [...firstSegment.nonLexical, ...secondSegment.nonLexical],
    pauseBeforeMs: firstSegment.pauseBeforeMs,
    ttsPrompt: `${secondSegment.ttsPrompt} ${note}`,
  };
}

function mergeTinySegmentsForTts(segments: GeminiPerformanceScriptSegment[]) {
  const mergedSegments: GeminiPerformanceScriptSegment[] = [];
  let index = 0;

  while (index < segments.length) {
    const currentSegment = segments[index];
    const nextSegment = segments[index + 1];
    const previousSegment = mergedSegments[mergedSegments.length - 1];

    if (
      previousSegment &&
      isTinyTtsSegment(currentSegment) &&
      getSegmentGap(previousSegment, currentSegment) <= getTinySegmentMergeGapSeconds()
    ) {
      const mergedSegment = mergeAdjacentSegments(
        previousSegment,
        currentSegment,
        "Include the short phrase naturally; do not over-emphasize it.",
      );

      mergedSegments[mergedSegments.length - 1] = mergedSegment;

      console.info("[gemini-performance-script-poc] Merged tiny segment into previous segment.", {
        previousId: previousSegment.id,
        tinySegmentId: currentSegment.id,
        tinyDurationSeconds: roundSeconds(getSegmentDuration(currentSegment)),
        gapSeconds: roundSeconds(getSegmentGap(previousSegment, currentSegment)),
        mergedStart: mergedSegment.start,
        mergedEnd: mergedSegment.end,
        text: mergedSegment.ttsText.slice(0, 100),
      });

      index += 1;
      continue;
    }

    if (
      nextSegment &&
      isTinyTtsSegment(currentSegment) &&
      getSegmentGap(currentSegment, nextSegment) <= getTinySegmentMergeGapSeconds()
    ) {
      const mergedSegment = mergeAdjacentSegments(
        currentSegment,
        nextSegment,
        "Include the short leading phrase naturally; do not over-emphasize it.",
      );

      console.info("[gemini-performance-script-poc] Merged tiny segment into following segment.", {
        tinySegmentId: currentSegment.id,
        nextId: nextSegment.id,
        tinyDurationSeconds: roundSeconds(getSegmentDuration(currentSegment)),
        gapSeconds: roundSeconds(getSegmentGap(currentSegment, nextSegment)),
        mergedStart: mergedSegment.start,
        mergedEnd: mergedSegment.end,
        text: mergedSegment.ttsText.slice(0, 100),
      });

      mergedSegments.push(mergedSegment);
      index += 2;
      continue;
    }

    mergedSegments.push(currentSegment);
    index += 1;
  }

  return mergedSegments;
}

function getTimelineCoverage(script: GeminiPerformanceScript, originalDurationSeconds: number) {
  if (originalDurationSeconds <= 0) {
    return {
      lastEndSeconds: 0,
      ratio: 1,
      segmentCount: script.segments.length,
    };
  }

  const timelineSegments = normalizeTimelineSegments(script, originalDurationSeconds);
  const lastEndSeconds = Math.max(...timelineSegments.map((segment) => segment.end), 0);

  return {
    lastEndSeconds: roundSeconds(lastEndSeconds),
    ratio: Math.min(1, lastEndSeconds / originalDurationSeconds),
    segmentCount: timelineSegments.length,
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

function getComparisonWords(text: string) {
  return normalizeForComparison(text)
    .split(" ")
    .filter((word) => word.length >= 3);
}

const englishMarkerWords = new Set([
  "about",
  "after",
  "again",
  "all",
  "and",
  "because",
  "before",
  "but",
  "can",
  "congratulations",
  "decent",
  "dice",
  "dokey",
  "everybody",
  "for",
  "going",
  "gonna",
  "good",
  "green",
  "had",
  "keep",
  "later",
  "left",
  "like",
  "luck",
  "maybe",
  "need",
  "next",
  "okay",
  "okey",
  "only",
  "red",
  "remember",
  "right",
  "round",
  "session",
  "shortly",
  "something",
  "talk",
  "the",
  "there",
  "thing",
  "think",
  "though",
  "two",
  "want",
  "was",
  "were",
  "what",
  "with",
  "you",
  "your",
]);

function hasSourceLanguageLeak(
  sourceText: string,
  candidateText: string,
) {
  const sourceWords = new Set(getComparisonWords(sourceText));
  const candidateWords = getComparisonWords(stripInlineCues(candidateText));

  if (sourceWords.size === 0 || candidateWords.length < 4) {
    return false;
  }

  const sourceOverlapCount = candidateWords.filter((word) => sourceWords.has(word)).length;
  const englishMarkerCount = candidateWords.filter((word) => englishMarkerWords.has(word)).length;
  const sourceOverlapRatio = sourceOverlapCount / candidateWords.length;
  const englishMarkerRatio = englishMarkerCount / candidateWords.length;

  return (
    (candidateWords.length >= 6 && sourceOverlapCount >= 4 && sourceOverlapRatio >= 0.3) ||
    (candidateWords.length >= 6 && englishMarkerCount >= 4 && englishMarkerRatio >= 0.25) ||
    (candidateWords.length < 6 && sourceOverlapCount >= 3)
  );
}

function isLikelyUntranslatedSegment(segment: GeminiPerformanceScriptSegment) {
  const source = normalizeForComparison(segment.sourceText);
  const translated = normalizeForComparison(stripInlineCues(segment.translatedText));
  const tts = normalizeForComparison(stripInlineCues(segment.ttsText));

  if (!source || (!translated && !tts)) {
    return false;
  }

  return (
    source === translated ||
    source === tts ||
    hasSourceLanguageLeak(segment.sourceText, segment.translatedText) ||
    hasSourceLanguageLeak(segment.sourceText, segment.ttsText)
  );
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

  const compactSegments = untranslatedSegments.map((segment) => ({
    id: segment.id,
    sourceText: segment.sourceText,
    currentTranslatedText: segment.translatedText,
    currentTtsText: segment.ttsText,
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
            text: `Repair only these untranslated performance segments by translating every sourceText into natural ${targetLanguageLabel}.
Return strict JSON only with this exact shape: {"segments": array}.
Keep the same segment ids. Do not add, remove, reorder, retime, or merge segments.
Do not include start/end unless they are already present below.
Do not leave translatedText or ttsText in the source language.
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

  const repairedSegmentsById = new Map(
    getScriptSegments(repairedScript).map((segment) => [Number(segment.id), segment]),
  );
  const repairedSegments = script.segments.map((segment) => {
    const repairedSegment = repairedSegmentsById.get(Number(segment.id));

    if (!repairedSegment) {
      return segment;
    }

    const translatedText = preserveInterjections(
      segment.sourceText,
      repairedSegment.translatedText?.trim() || segment.translatedText,
      targetLanguageCode,
    );
    const ttsText = preserveInterjections(
      segment.sourceText,
      repairedSegment.ttsText?.trim() || translatedText || segment.ttsText,
      targetLanguageCode,
    );

    return {
      ...segment,
      translatedText,
      ttsText,
      ttsPrompt: repairedSegment.ttsPrompt?.trim() || segment.ttsPrompt,
    };
  });
  const repairedScriptWithOriginalTimeline = {
    originalTranscript: script.originalTranscript,
    translatedText: repairedSegments.map((segment) => segment.translatedText).join(" ").trim(),
    segments: repairedSegments,
  } satisfies GeminiPerformanceScript;

  console.info("[gemini-performance-script-poc] Applied untranslated segment repair without changing timeline.", {
    repairedSegments: repairedSegmentsById.size,
    totalSegments: repairedScriptWithOriginalTimeline.segments.length,
    sample: repairedScriptWithOriginalTimeline.segments.slice(0, 5).map((segment) => ({
      id: segment.id,
      start: segment.start,
      end: segment.end,
      emotion: segment.emotion,
      intensity: segment.intensity,
      text: segment.ttsText.slice(0, 80),
    })),
  });

  return repairedScriptWithOriginalTimeline;
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

async function runFfprobeDuration(filePath: string) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      filePath,
    ],
    {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    },
  );
  const duration = Number(stdout.trim());

  return Number.isFinite(duration) ? duration : 0;
}

async function getAudioBufferDuration(audioBuffer: Buffer) {
  const tempDirectory = join(tmpdir(), `gemini-performance-script-probe-${randomUUID()}`);
  const audioPath = join(tempDirectory, "source-audio");

  await mkdir(tempDirectory, { recursive: true });

  try {
    await writeFile(audioPath, audioBuffer);
    return await runFfprobeDuration(audioPath);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function splitAudioBufferIntoChunks(
  audioBuffer: Buffer,
  totalDurationSeconds: number,
  chunkSeconds: number,
) {
  const tempDirectory = join(tmpdir(), `gemini-performance-script-chunks-${randomUUID()}`);
  const inputPath = join(tempDirectory, "source-audio");
  const chunks: Array<{
    index: number;
    startSeconds: number;
    durationSeconds: number;
    audioBuffer: Buffer;
    mimeType: string;
  }> = [];

  await mkdir(tempDirectory, { recursive: true });

  try {
    await writeFile(inputPath, audioBuffer);

    for (
      let chunkIndex = 0, startSeconds = 0;
      startSeconds < totalDurationSeconds - 0.1;
      chunkIndex += 1, startSeconds += chunkSeconds
    ) {
      const durationSeconds = Math.min(chunkSeconds, totalDurationSeconds - startSeconds);
      const outputPath = join(tempDirectory, `chunk-${chunkIndex}.mp3`);

      await runFfmpeg([
        "-ss",
        startSeconds.toFixed(3),
        "-t",
        durationSeconds.toFixed(3),
        "-i",
        inputPath,
        "-vn",
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "3",
        "-y",
        outputPath,
      ]);

      chunks.push({
        index: chunkIndex,
        startSeconds,
        durationSeconds: await runFfprobeDuration(outputPath),
        audioBuffer: await readFile(outputPath),
        mimeType: "audio/mpeg",
      });
    }
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }

  return chunks;
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

async function repairIncompleteTimelineScript({
  apiKey,
  audioBase64,
  audioMimeType,
  script,
  originalDurationSeconds,
  targetLanguageLabel,
  targetLanguageCode,
}: {
  apiKey: string;
  audioBase64: string;
  audioMimeType: string;
  script: GeminiPerformanceScript;
  originalDurationSeconds: number;
  targetLanguageLabel: string;
  targetLanguageCode: TranslationLanguage;
}) {
  const coverage = getTimelineCoverage(script, originalDurationSeconds);
  const minCoverageRatio = getMinTimelineCoverageRatio();

  console.info("[gemini-performance-script-poc] Timeline script coverage diagnostics.", {
    originalDurationSeconds: roundSeconds(originalDurationSeconds),
    lastEndSeconds: coverage.lastEndSeconds,
    coverageRatio: roundSeconds(coverage.ratio),
    minCoverageRatio,
    segmentCount: coverage.segmentCount,
  });

  if (coverage.ratio >= minCoverageRatio) {
    return script;
  }

  console.warn("[gemini-performance-script-poc] Timeline coverage is too low; requesting repair.", {
    originalDurationSeconds: roundSeconds(originalDurationSeconds),
    lastEndSeconds: coverage.lastEndSeconds,
    coverageRatio: roundSeconds(coverage.ratio),
    minCoverageRatio,
  });

  const payload = await postGeminiGenerateContentWithFallback(
    apiKey,
    [scriptModel, fallbackScriptModel].filter((model, index, models) => model && models.indexOf(model) === index),
    {
      contents: [
        {
          parts: [
            {
              text: `Repair the translated dubbing performance script for the attached audio.
The previous script only covered audio until ${coverage.lastEndSeconds}s, but the source audio is approximately ${roundSeconds(
                originalDurationSeconds,
              )}s long and may contain speech after that point.
Return strict one-line JSON only with exactly this shape: {"originalTranscript": string, "translatedText": string, "segments": array}.
Never summarize. Do not stop early. Include all spoken content from the first speech through the final spoken phrase.
Return 2-${maxScriptSegments} timestamped segments. Each segment must include id,start,end,sourceText,translatedText,ttsText,emotion,intensity,volume,pace,nonLexical,pauseBeforeMs,pauseAfterMs,ttsPrompt.
start and end must be source-audio timestamps in seconds, not milliseconds.
The final segment end must be near the last spoken phrase. If speech continues near the end of the clip, the final segment should end near ${roundSeconds(
                originalDurationSeconds,
              )}s.
Keep short exhale/interjection sounds attached to the following phrase when they lead into it.
Translate into natural ${targetLanguageLabel}; do not leave source-language text in translatedText or ttsText.
Previous incomplete script: ${JSON.stringify({
                originalTranscript: script.originalTranscript,
                translatedText: script.translatedText,
                segments: script.segments.map((segment) => ({
                  id: segment.id,
                  start: segment.start,
                  end: segment.end,
                  sourceText: segment.sourceText,
                  translatedText: segment.translatedText,
                })),
              })}`,
            },
            {
              inlineData: {
                mimeType: audioMimeType,
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
    },
    "timeline coverage repair",
  ).catch((error) => {
    console.warn("[gemini-performance-script-poc] Timeline coverage repair failed.", {
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
    "timeline coverage repair script",
  );

  if (!repairedScript) {
    return script;
  }

  const normalizedRepairedScript = normalizeParsedScript(
    repairedScript,
    script.originalTranscript,
    targetLanguageLabel,
    targetLanguageCode,
  );
  const repairedCoverage = getTimelineCoverage(normalizedRepairedScript, originalDurationSeconds);

  console.info("[gemini-performance-script-poc] Repaired timeline coverage diagnostics.", {
    originalDurationSeconds: roundSeconds(originalDurationSeconds),
    beforeLastEndSeconds: coverage.lastEndSeconds,
    afterLastEndSeconds: repairedCoverage.lastEndSeconds,
    beforeCoverageRatio: roundSeconds(coverage.ratio),
    afterCoverageRatio: roundSeconds(repairedCoverage.ratio),
    segmentCount: repairedCoverage.segmentCount,
  });

  return repairedCoverage.ratio > coverage.ratio ? normalizedRepairedScript : script;
}

async function createPerformanceScriptForChunk({
  apiKey,
  audioBuffer,
  audioMimeType,
  originalDurationSeconds,
  targetLanguageLabel,
  targetLanguageCode,
  chunkOffsetSeconds = 0,
  chunkIndex = 0,
  totalChunks = 1,
}: {
  apiKey: string;
  audioBuffer: Buffer;
  audioMimeType: string;
  originalDurationSeconds: number;
  targetLanguageLabel: string;
  targetLanguageCode: TranslationLanguage;
  chunkOffsetSeconds?: number;
  chunkIndex?: number;
  totalChunks?: number;
}) {
  console.info("[gemini-performance-script-poc] Requesting audio-aware performance script.", {
    model: scriptModel,
    bytes: audioBuffer.byteLength,
    type: audioMimeType,
    targetLanguageLabel,
    chunkIndex: chunkIndex + 1,
    totalChunks,
    chunkOffsetSeconds: roundSeconds(chunkOffsetSeconds),
    chunkDurationSeconds: roundSeconds(originalDurationSeconds),
  });

  const audioBase64 = audioBuffer.toString("base64");
  const prompt = `You are creating a faithful translated dubbing performance script from the attached audio.
This is chunk ${chunkIndex + 1} of ${totalChunks}. The chunk starts at ${roundSeconds(
    chunkOffsetSeconds,
  )}s in the original full audio.
The attached chunk duration is approximately ${roundSeconds(originalDurationSeconds)} seconds.
Return strict one-line JSON only with exactly this top-level shape: {"originalTranscript": string, "translatedText": string, "segments": array}.
Never return markdown. Never return an empty segments array.
Return 2-${maxScriptSegments} segments for this attached chunk from the first speech in the chunk to the last speech in the chunk.
Each segment is one natural spoken reply, phrase, or short thought. Do not merge the whole clip into one segment unless the source is truly one very short utterance.
Do not stop early. Include all spoken content until the final spoken phrase in this chunk.
If speech continues after the midpoint, continue segmenting and translating it. The final segment end must be near the final spoken phrase, not where the first topic ends.
Do not split a short exhale or interjection such as "Whoof", "Uf", "Ah", or "Oh" into its own segment when it immediately leads into the next phrase. Keep it attached to the following spoken reply.
originalTranscript must be a faithful transcript of the spoken source audio, not a summary or description.
translatedText must be the full natural ${targetLanguageLabel} translation of the spoken clip, not a short summary.
ttsText must be the full speakable ${targetLanguageLabel} performance script for Gemini TTS.

Analyze the audio directly, not only the words. Detect emotion, intensity, loudness, pace, breaths, sighs, laughter, hesitation, elongated sounds, and expressive interjections.
Match tone, pacing, and emphasis to the original audio. Preserve where the speaker speeds up, slows down, stresses a word, softens, pauses, or hesitates.
Infer only noticeable pauses from the source audio and place them in ttsText as performance cues at the matching points. Use cues like [pause 700], [pause 1200], or [long pause 1800] when a pause is clearly perceptible. Do not annotate micro-pauses, normal comma rhythm, or every breath.
Translate into natural ${targetLanguageLabel}, but preserve the original emotional intensity exactly. Keep the casino entertainment host context: clear, present, lightly upbeat, and projected. Do not make it more dramatic or theatrical than the original.
Do not label normal host curiosity, thinking, or anticipation as fear, anxiety, nervousness, dread, concern, or suspense.
Prefer confident presenter labels such as "confident casino presenter", "upbeat announcing", "warm amused presenter", or "steady explaining".
If the source contains sounds such as фууух/ух/ах/ой/мм/ха-ха, translatedText must include a natural speakable equivalent such as "Uf...", "¡Ah!", "¡Ay!", "Mmm...", or laughter in ${targetLanguageLabel}. Do not silently drop these sounds.
Do not mark breathy exhale sounds like "Whoof"/"Uf" as laughter unless the source clearly contains real laughter.

Each segment must include:
id, start, end, sourceText, translatedText, ttsText, emotion, intensity 0-1, volume one of whisper/soft/medium/loud/shout, pace one of very slow/slow/medium/fast/very fast, nonLexical array, pauseBeforeMs, pauseAfterMs, ttsPrompt.
start and end must be timestamps in seconds relative to this attached chunk, starting at 0. Do not use original global timestamps. Do not use milliseconds.
Every segment must have end greater than start. Preserve real gaps between replies by leaving gaps between adjacent segment timestamps.
Avoid ultra-short segments below 1.2 seconds unless there is a real long pause after them. Attach short words like "Okay", "Claro", "Así que", or "Vale" to the surrounding phrase.
The segment timeline should cover the complete spoken audio. If there is speech near ${roundSeconds(
    originalDurationSeconds,
  )}s, the last segment end should be near that time.
Use volume, pace, and intensity that match the original segment. Most normal casino host speech should be medium volume, medium pace, and intensity 0.62-0.78 so it does not sound flat but also does not overact. Use intensity above 0.8 only for clear shouting or peak excitement in the source.
Do not use generic emotion "conversational" for host patter. Prefer labels like "engaged casino host", "upbeat", "amused", "announcing", or "excited" when they match the source.

translatedText is clean readable translated text.
ttsText is the exact speakable performance text for Gemini TTS. It should include inline cues when needed, for example: [laughs] I did NOT expect that. [sigh] Can you believe it!
Use cues like [laughs], [sigh], [gasps], [whispers], [excited], [breathy], [shouts], [pause 900], and [long pause 1800] only when they match the original audio performance.
For "Whoof"/"Uf" style releases, prefer [exhale] or plain "Uf..." instead of [laughs].
Do not add extra intro sounds, reactions, or filler that are not in the source audio.
ttsPrompt should be a concise director note for Gemini TTS under 160 characters. It must say to match the original delivery and not exaggerate.`;
  const requestBody = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: audioMimeType,
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
      "[gemini-performance-script-poc] Gemini returned invalid script JSON.",
    );

    if (originalDurationSeconds > getMinScriptChunkSeconds() + 1) {
      return splitAndCreatePerformanceScriptForChunk({
        apiKey,
        audioBuffer,
        originalDurationSeconds,
        targetLanguageLabel,
        targetLanguageCode,
        chunkOffsetSeconds,
        chunkIndex,
        totalChunks,
        reason: "invalid-json",
      });
    }

    const repairedScript = await repairPerformanceScriptFromInvalidJson(
      apiKey,
      scriptText,
      targetLanguageLabel,
      targetLanguageCode,
    );

    return repairIncompleteTimelineScript({
      apiKey,
      audioBase64,
      audioMimeType,
      script: repairedScript,
      originalDurationSeconds,
      targetLanguageLabel,
      targetLanguageCode,
    });
  }

  const normalizedScript = normalizeParsedScript(
    parsedScript,
    scriptText,
    targetLanguageLabel,
    targetLanguageCode,
  );

  return repairIncompleteTimelineScript({
    apiKey,
    audioBase64,
    audioMimeType,
    script: normalizedScript,
    originalDurationSeconds,
    targetLanguageLabel,
    targetLanguageCode,
  });
}

function offsetPerformanceScript(
  script: GeminiPerformanceScript,
  offsetSeconds: number,
  idOffset: number,
) {
  return {
    ...script,
    segments: script.segments.map((segment, index) => ({
      ...segment,
      id: idOffset + index + 1,
      start: segment.start + offsetSeconds,
      end: segment.end + offsetSeconds,
    })),
  } satisfies GeminiPerformanceScript;
}

function mergePerformanceScripts(scripts: GeminiPerformanceScript[]) {
  return {
    originalTranscript: scripts.map((script) => script.originalTranscript).join(" ").trim(),
    translatedText: scripts.map((script) => script.translatedText).join(" ").trim(),
    segments: scripts.flatMap((script) => script.segments),
  } satisfies GeminiPerformanceScript;
}

async function splitAndCreatePerformanceScriptForChunk({
  apiKey,
  audioBuffer,
  originalDurationSeconds,
  targetLanguageLabel,
  targetLanguageCode,
  chunkOffsetSeconds,
  chunkIndex,
  totalChunks,
  reason,
}: {
  apiKey: string;
  audioBuffer: Buffer;
  originalDurationSeconds: number;
  targetLanguageLabel: string;
  targetLanguageCode: TranslationLanguage;
  chunkOffsetSeconds: number;
  chunkIndex: number;
  totalChunks: number;
  reason: string;
}) {
  const splitSeconds = Math.max(
    getMinScriptChunkSeconds(),
    Math.ceil(originalDurationSeconds / 2),
  );

  console.warn("[gemini-performance-script-poc] Splitting script chunk into smaller chunks.", {
    reason,
    chunkIndex: chunkIndex + 1,
    totalChunks,
    chunkOffsetSeconds: roundSeconds(chunkOffsetSeconds),
    originalDurationSeconds: roundSeconds(originalDurationSeconds),
    splitSeconds,
  });

  const subchunks = await splitAudioBufferIntoChunks(audioBuffer, originalDurationSeconds, splitSeconds);
  const subchunkScripts: GeminiPerformanceScript[] = [];
  let idOffset = 0;

  for (const subchunk of subchunks) {
    const subchunkScript = await createPerformanceScriptForChunk({
      apiKey,
      audioBuffer: subchunk.audioBuffer,
      audioMimeType: subchunk.mimeType,
      originalDurationSeconds: subchunk.durationSeconds,
      targetLanguageLabel,
      targetLanguageCode,
      chunkOffsetSeconds: chunkOffsetSeconds + subchunk.startSeconds,
      chunkIndex: subchunk.index,
      totalChunks: subchunks.length,
    });
    const offsetScript = offsetPerformanceScript(subchunkScript, subchunk.startSeconds, idOffset);

    idOffset += offsetScript.segments.length;
    subchunkScripts.push(offsetScript);
  }

  return mergePerformanceScripts(subchunkScripts);
}

async function createPerformanceScript(
  apiKey: string,
  audioFile: File,
  targetLanguageLabel: string,
  targetLanguageCode: TranslationLanguage,
) {
  const audioBuffer = Buffer.from(await audioFile.arrayBuffer());
  const originalDurationSeconds = await getAudioBufferDuration(audioBuffer).catch((error) => {
    console.warn("[gemini-performance-script-poc] Could not read source duration before script.", {
      error: error instanceof Error ? error.message : String(error),
    });

    return 0;
  });
  const chunkSeconds = getScriptChunkSeconds();
  const shouldChunk = originalDurationSeconds > chunkSeconds + 5;

  if (!shouldChunk) {
    if (audioBuffer.byteLength > maxAudioBytes) {
      throw new Error("Audio file is larger than the Gemini POC limit.");
    }

    return createPerformanceScriptForChunk({
      apiKey,
      audioBuffer,
      audioMimeType: audioFile.type || "audio/mpeg",
      originalDurationSeconds,
      targetLanguageLabel,
      targetLanguageCode,
    });
  }

  console.info("[gemini-performance-script-poc] Splitting long audio for script analysis.", {
    originalDurationSeconds: roundSeconds(originalDurationSeconds),
    chunkSeconds,
    estimatedChunks: Math.ceil(originalDurationSeconds / chunkSeconds),
  });

  const chunks = await splitAudioBufferIntoChunks(audioBuffer, originalDurationSeconds, chunkSeconds);
  const chunkScripts: GeminiPerformanceScript[] = [];
  let idOffset = 0;

  for (const chunk of chunks) {
    if (chunk.audioBuffer.byteLength > maxAudioBytes) {
      throw new Error(`Audio chunk ${chunk.index + 1} is larger than the Gemini POC limit.`);
    }

    const chunkScript = await createPerformanceScriptForChunk({
      apiKey,
      audioBuffer: chunk.audioBuffer,
      audioMimeType: chunk.mimeType,
      originalDurationSeconds: chunk.durationSeconds,
      targetLanguageLabel,
      targetLanguageCode,
      chunkOffsetSeconds: chunk.startSeconds,
      chunkIndex: chunk.index,
      totalChunks: chunks.length,
    });
    const offsetScript = offsetPerformanceScript(chunkScript, chunk.startSeconds, idOffset);

    idOffset += offsetScript.segments.length;
    chunkScripts.push(offsetScript);

    console.info("[gemini-performance-script-poc] Completed script chunk.", {
      chunkIndex: chunk.index + 1,
      totalChunks: chunks.length,
      chunkOffsetSeconds: roundSeconds(chunk.startSeconds),
      chunkDurationSeconds: roundSeconds(chunk.durationSeconds),
      segments: offsetScript.segments.length,
      lastSegmentEnd: roundSeconds(Math.max(...offsetScript.segments.map((segment) => segment.end), 0)),
    });
  }

  const mergedScript = {
    originalTranscript: chunkScripts.map((script) => script.originalTranscript).join(" ").trim(),
    translatedText: chunkScripts.map((script) => script.translatedText).join(" ").trim(),
    segments: chunkScripts.flatMap((script) => script.segments),
  } satisfies GeminiPerformanceScript;

  console.info("[gemini-performance-script-poc] Merged script chunks.", {
    chunks: chunkScripts.length,
    segments: mergedScript.segments.length,
    originalDurationSeconds: roundSeconds(originalDurationSeconds),
    lastSegmentEnd: roundSeconds(Math.max(...mergedScript.segments.map((segment) => segment.end), 0)),
  });

  return mergedScript;
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
      emotion: normalizeTtsEmotion(segment.emotion),
      intensity: normalizeTtsIntensity(segment.intensity),
      volume: normalizeTtsVolume(segment.volume),
      pace: normalizeTtsPace(segment.pace),
      pauseBeforeMs: segment.pauseBeforeMs,
      pauseAfterMs: segment.pauseAfterMs,
      nonLexical: segment.nonLexical,
      directorNotes: buildTtsDirectorNote(segment),
    },
  }));
  const performanceNotes = performanceLines
    .map((line) =>
      [
        `Line ${line.line}`,
        `emotion: ${line.delivery.emotion}`,
        `intensity: ${line.delivery.intensity}`,
        `volume: ${line.delivery.volume}`,
        `pace: ${line.delivery.pace}`,
        line.delivery.directorNotes ? `note: ${line.delivery.directorNotes}` : null,
      ]
        .filter(Boolean)
        .join("; "),
    )
    .join("\n");
  const ttsPayload = {
    model: ttsModel,
    prompt: `${ttsContext}
Perform this complete translated dubbing script in ${targetLanguageLabel} while matching the original audio's emotional contour.
Use the exact text content, but perform it according to delivery notes. Do not flatten real emotion, but also do not exaggerate it.
Match tone, pacing, and emphasis to the original audio as closely as Gemini TTS allows.
The delivery should remain natural for casino entertainment, but faithful to the source: same approximate calmness, hesitation, excitement, sighs, and intensity.
Avoid flat audiobook narration. Use a clear projected casino host voice with engaged entertainment energy.
Never sound frightened, hesitant from fear, timid, shaky, breathless, or like something bad is happening.
This is live casino entertainment, not suspense, horror, danger, or worried narration.
Treat "conversational" or neutral host patter as engaged casino-host conversation, not low-energy speech.
Do not make neutral or mildly expressive lines sound highly excited.
Preserve expressive interjections, breathy exclamations, pauses, volume changes, pacing, and emotional intensity.
Inline cues like [laughs], [sigh], [breathy], [excited], [pause 900], or [long pause 1800] are performance cues, not words to explain.
Follow the pause cues naturally. Do not read the bracketed cue text aloud.
Use a natural clear voice. Do not whisper, do not murmur, and do not speak softly unless the original audio is clearly quiet or the text explicitly says [whispers].
Keep pitch comfortably low/medium and presenter-like; avoid a squeaky, thin, nervous tone.
Use one continuous natural synthetic voice. Do not clone or imitate the original speaker's voice.

Performance notes:
${performanceNotes}`,
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

function buildAtempoFilter(speedRatio: number) {
  const filters: string[] = [];
  let remainingRatio = speedRatio;

  while (remainingRatio > 2) {
    filters.push("atempo=2");
    remainingRatio /= 2;
  }

  while (remainingRatio < 0.5) {
    filters.push("atempo=0.5");
    remainingRatio /= 0.5;
  }

  filters.push(`atempo=${remainingRatio.toFixed(4)}`);

  return filters.join(",");
}

function escapeConcatPath(filePath: string) {
  return filePath.replace(/'/g, "'\\''");
}

async function createSilenceMp3(outputPath: string, durationSeconds: number) {
  await runFfmpeg([
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=24000:cl=mono",
    "-t",
    durationSeconds.toFixed(3),
    "-codec:a",
    "libmp3lame",
    "-q:a",
    "3",
    "-y",
    outputPath,
  ]);
}

async function concatMp3Files(inputPaths: string[], outputPath: string, tempDirectory: string) {
  const concatListPath = join(tempDirectory, "concat-list.txt");
  const concatList = inputPaths.map((inputPath) => `file '${escapeConcatPath(inputPath)}'`).join("\n");

  await writeFile(concatListPath, concatList);
  await runFfmpeg([
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    concatListPath,
    "-codec",
    "copy",
    "-y",
    outputPath,
  ]);
}

function normalizeTimelineSegments(script: GeminiPerformanceScript, originalDurationSeconds: number) {
  const rawSegments = script.segments
    .map((segment, index) => ({
      ...segment,
      id: Number.isFinite(Number(segment.id)) ? Number(segment.id) : index,
      start: Number(segment.start),
      end: Number(segment.end),
    }))
    .filter((segment) => segment.ttsText || segment.translatedText)
    .sort((left, right) => left.start - right.start);
  const maxEnd = Math.max(...rawSegments.map((segment) => segment.end).filter(Number.isFinite), 0);
  const timestampScale =
    originalDurationSeconds > 0 && maxEnd > originalDurationSeconds * 2 && maxEnd > 1000 ? 0.001 : 1;
  let cursor = 0;

  const normalizedSegments = rawSegments
    .map((segment) => {
      const rawStart = Number.isFinite(segment.start) ? segment.start * timestampScale : cursor;
      const rawEnd = Number.isFinite(segment.end) ? segment.end * timestampScale : rawStart;
      const start = Math.max(0, Math.min(originalDurationSeconds, rawStart));
      const end = Math.max(start, Math.min(originalDurationSeconds, rawEnd));

      if (end <= start) {
        return null;
      }

      cursor = end;

      return {
        ...segment,
        start,
        end,
      };
    })
    .filter((segment): segment is GeminiPerformanceScriptSegment => segment !== null);

  return mergeTinySegmentsForTts(normalizedSegments);
}

async function generateSegmentSpeechPcm(
  apiKey: string,
  segment: GeminiPerformanceScriptSegment,
  targetLanguageLabel: string,
  index: number,
) {
  console.info("[gemini-performance-script-poc] Requesting Gemini TTS segment.", {
    model: ttsModel,
    voice: ttsSpeaker,
    segmentId: segment.id,
    index,
    slotSeconds: roundSeconds(segment.end - segment.start),
    emotion: segment.emotion,
    ttsEmotion: normalizeTtsEmotion(segment.emotion),
    intensity: segment.intensity,
    ttsIntensity: normalizeTtsIntensity(segment.intensity),
    volume: segment.volume,
    pace: segment.pace,
  });

  const text = segment.ttsText || segment.translatedText;

  if (!stripInlineCues(text).trim()) {
    console.warn("[gemini-performance-script-poc] Segment has no speakable text.", {
      segmentId: segment.id,
      index,
    });

    throw new Error(`Segment ${segment.id} has no speakable text.`);
  }

  const ttsPayload = {
    model: ttsModel,
    prompt: `${ttsContext}
Say this translated ${targetLanguageLabel} casino-host line inside the same time slot as the source reply.
Match the original source reply's timing and intent without exaggeration.
Use a clear, confident, projected live casino presenter voice. Do not whisper unless the text says [whispers].
Never sound scared, anxious, timid, shaky, breathless, or worried.
This is casino entertainment, not danger or suspense narration.
Keep pitch comfortably low/medium and presenter-like; avoid a squeaky or thin tone.
Follow bracketed performance cues naturally and do not read the cue text aloud.
Do not clone or imitate the original speaker's voice.

Delivery:
emotion: ${normalizeTtsEmotion(segment.emotion)}
intensity: ${normalizeTtsIntensity(segment.intensity)}
volume: ${normalizeTtsVolume(segment.volume)}
pace: ${normalizeTtsPace(segment.pace)}
director note: ${buildTtsDirectorNote(segment)}`,
    text,
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
    throw new Error(`Gemini TTS returned no audio for segment ${segment.id}.`);
  }

  return audioBuffer;
}

async function fitMp3ToSlot(
  inputPath: string,
  outputPath: string,
  slotSeconds: number,
  knownRawOutputDurationSeconds?: number,
) {
  const rawOutputDurationSeconds =
    knownRawOutputDurationSeconds ?? (await runFfprobeDuration(inputPath));

  if (slotSeconds <= 0 || rawOutputDurationSeconds <= 0) {
    await writeFile(outputPath, await readFile(inputPath));

    return {
      rawTtsSeconds: roundSeconds(rawOutputDurationSeconds),
      finalSegmentSeconds: roundSeconds(rawOutputDurationSeconds),
      speedApplied: 1,
      clipped: false,
    };
  }

  const rawSpeedRatio = rawOutputDurationSeconds / slotSeconds;
  const maxSpeedUp = Math.max(1, getNumberEnv("GEMINI_PERFORMANCE_SEGMENT_MAX_SPEED_UP", 1.3));
  const speedRatio = rawSpeedRatio > 1 ? Math.min(rawSpeedRatio, maxSpeedUp) : 1;
  const fittedSpeechSeconds = rawOutputDurationSeconds / speedRatio;
  const outputSeconds = Math.max(slotSeconds, fittedSpeechSeconds);

  await runFfmpeg([
    "-i",
    inputPath,
    "-filter:a",
    `${buildAtempoFilter(speedRatio)},apad=pad_dur=${outputSeconds.toFixed(3)}`,
    "-t",
    outputSeconds.toFixed(3),
    "-codec:a",
    "libmp3lame",
    "-q:a",
    "3",
    "-y",
    outputPath,
  ]);

  const finalOutputDurationSeconds = await runFfprobeDuration(outputPath);

  return {
    rawTtsSeconds: roundSeconds(rawOutputDurationSeconds),
    finalSegmentSeconds: roundSeconds(finalOutputDurationSeconds),
    speedApplied: roundSeconds(speedRatio),
    clipped: false,
    overrunSeconds: roundSeconds(Math.max(0, finalOutputDurationSeconds - slotSeconds)),
  };
}

function calculatePauseBorrowForSegment({
  rawTtsSeconds,
  slotSeconds,
  gapBeforeSeconds,
  gapAfterSeconds,
}: {
  rawTtsSeconds: number;
  slotSeconds: number;
  gapBeforeSeconds: number;
  gapAfterSeconds: number;
}) {
  const targetSpeedUp = getTargetSegmentSpeedUp();
  const desiredSlotSeconds = rawTtsSeconds / targetSpeedUp;
  const borrowNeededSeconds = Math.max(0, desiredSlotSeconds - slotSeconds);

  if (borrowNeededSeconds <= 0) {
    return {
      effectiveSlotSeconds: slotSeconds,
      borrowedPauseBeforeSeconds: 0,
      borrowedPauseAfterSeconds: 0,
    };
  }

  const maxBorrowRatio = getMaxPauseBorrowRatio();
  const maxBorrowSeconds = getMaxPauseBorrowSeconds();
  const minRemainingPauseSeconds = getMinRemainingPauseSeconds();
  const availableBeforeSeconds = Math.min(
    Math.max(0, gapBeforeSeconds - minRemainingPauseSeconds),
    gapBeforeSeconds * maxBorrowRatio,
  );
  const availableAfterSeconds = Math.min(
    Math.max(0, gapAfterSeconds - minRemainingPauseSeconds),
    gapAfterSeconds * maxBorrowRatio,
  );
  const availablePauseSeconds = availableBeforeSeconds + availableAfterSeconds;
  const totalBorrowSeconds = Math.min(
    borrowNeededSeconds,
    availablePauseSeconds,
    maxBorrowSeconds,
  );

  if (totalBorrowSeconds <= 0 || availablePauseSeconds <= 0) {
    return {
      effectiveSlotSeconds: slotSeconds,
      borrowedPauseBeforeSeconds: 0,
      borrowedPauseAfterSeconds: 0,
    };
  }

  let borrowedPauseBeforeSeconds =
    totalBorrowSeconds * (availableBeforeSeconds / availablePauseSeconds);
  let borrowedPauseAfterSeconds = totalBorrowSeconds - borrowedPauseBeforeSeconds;

  if (borrowedPauseBeforeSeconds > availableBeforeSeconds) {
    const overflowSeconds = borrowedPauseBeforeSeconds - availableBeforeSeconds;

    borrowedPauseBeforeSeconds = availableBeforeSeconds;
    borrowedPauseAfterSeconds = Math.min(
      availableAfterSeconds,
      borrowedPauseAfterSeconds + overflowSeconds,
    );
  }

  if (borrowedPauseAfterSeconds > availableAfterSeconds) {
    const overflowSeconds = borrowedPauseAfterSeconds - availableAfterSeconds;

    borrowedPauseAfterSeconds = availableAfterSeconds;
    borrowedPauseBeforeSeconds = Math.min(
      availableBeforeSeconds,
      borrowedPauseBeforeSeconds + overflowSeconds,
    );
  }

  return {
    effectiveSlotSeconds: slotSeconds + borrowedPauseBeforeSeconds + borrowedPauseAfterSeconds,
    borrowedPauseBeforeSeconds,
    borrowedPauseAfterSeconds,
  };
}

async function renderSegmentSlotAudio(
  apiKey: string,
  script: GeminiPerformanceScript,
  targetLanguageLabel: string,
  originalAudioFile: File,
  outputPath: string,
  tempDirectory: string,
) {
  const originalPath = join(tempDirectory, "original-audio");

  await writeFile(originalPath, Buffer.from(await originalAudioFile.arrayBuffer()));

  const originalDurationSeconds = await runFfprobeDuration(originalPath);
  const timelineSegments = normalizeTimelineSegments(script, originalDurationSeconds);

  if (originalDurationSeconds <= 0 || timelineSegments.length === 0) {
    return null;
  }

  console.info("[gemini-performance-script-poc] Rendering segment slots.", {
    originalDurationSeconds: roundSeconds(originalDurationSeconds),
    sourceSegments: script.segments.length,
    timelineSegments: timelineSegments.length,
    sample: timelineSegments.slice(0, 6).map((segment, index) => ({
      index,
      id: segment.id,
      start: roundSeconds(segment.start),
      end: roundSeconds(segment.end),
      slotSeconds: roundSeconds(segment.end - segment.start),
      emotion: segment.emotion,
      intensity: segment.intensity,
      text: (segment.ttsText || segment.translatedText).slice(0, 80),
    })),
  });

  const outputParts: string[] = [];
  const segmentDiagnostics: NonNullable<DurationAlignmentDiagnostics["segments"]> = [];
  let cursor = 0;

  for (const [index, segment] of timelineSegments.entries()) {
    const gapSeconds = Math.max(0, segment.start - cursor);
    const nextSegment = timelineSegments[index + 1];
    const gapAfterSeconds = Math.max(
      0,
      (nextSegment?.start ?? originalDurationSeconds) - segment.end,
    );
    const slotSeconds = Math.max(0.05, segment.end - segment.start);
    const segmentPcmPath = join(tempDirectory, `segment-${index}.pcm`);
    const segmentRawMp3Path = join(tempDirectory, `segment-${index}-raw.mp3`);
    const segmentFittedMp3Path = join(tempDirectory, `segment-${index}-slot.mp3`);

    if (!hasSpeakableText(segment)) {
      if (gapSeconds >= 0.05) {
        const silencePath = join(tempDirectory, `silence-${index}.mp3`);

        await createSilenceMp3(silencePath, gapSeconds);
        outputParts.push(silencePath);
      }

      await createSilenceMp3(segmentFittedMp3Path, slotSeconds);

      const silenceDiagnostics = {
        rawTtsSeconds: 0,
        finalSegmentSeconds: roundSeconds(slotSeconds),
        speedApplied: 1,
        clipped: false,
        effectiveSlotSeconds: roundSeconds(slotSeconds),
        borrowedPauseBeforeSeconds: 0,
        borrowedPauseAfterSeconds: 0,
        silent: true,
      };

      segmentDiagnostics.push({
        id: segment.id,
        start: roundSeconds(segment.start),
        end: roundSeconds(segment.end),
        slotSeconds: roundSeconds(slotSeconds),
        ...silenceDiagnostics,
      });
      outputParts.push(segmentFittedMp3Path);
      cursor = segment.end;

      console.info("[gemini-performance-script-poc] Rendering non-speech segment as silence.", {
        index,
        id: segment.id,
        start: roundSeconds(segment.start),
        end: roundSeconds(segment.end),
        slotSeconds: roundSeconds(slotSeconds),
        gapBeforeSeconds: roundSeconds(gapSeconds),
        text: (segment.ttsText || segment.translatedText || segment.sourceText).slice(0, 80),
      });

      continue;
    }

    let fitDiagnostics:
      | {
          rawTtsSeconds: number;
          finalSegmentSeconds: number;
          speedApplied: number;
          clipped: boolean;
          overrunSeconds?: number;
          effectiveSlotSeconds?: number;
          borrowedPauseBeforeSeconds?: number;
          borrowedPauseAfterSeconds?: number;
          silent?: boolean;
          ttsFailed?: boolean;
        }
      | null = null;
    let effectiveSlotSeconds = slotSeconds;
    let borrowedPauseBeforeSeconds = 0;
    let borrowedPauseAfterSeconds = 0;

    try {
      const segmentAudioBuffer = await generateSegmentSpeechPcm(
        apiKey,
        segment,
        targetLanguageLabel,
        index,
      );

      await writeFile(segmentPcmPath, segmentAudioBuffer);
      await convertPcmToMp3(segmentPcmPath, segmentRawMp3Path);

      const rawTtsSeconds = await runFfprobeDuration(segmentRawMp3Path);
      const pauseBorrow = calculatePauseBorrowForSegment({
        rawTtsSeconds,
        slotSeconds,
        gapBeforeSeconds: gapSeconds,
        gapAfterSeconds,
      });

      effectiveSlotSeconds = pauseBorrow.effectiveSlotSeconds;
      borrowedPauseBeforeSeconds = pauseBorrow.borrowedPauseBeforeSeconds;
      borrowedPauseAfterSeconds = pauseBorrow.borrowedPauseAfterSeconds;

      const reducedGapSeconds = Math.max(0, gapSeconds - borrowedPauseBeforeSeconds);

      if (reducedGapSeconds >= 0.05) {
        const silencePath = join(tempDirectory, `silence-${index}.mp3`);

        await createSilenceMp3(silencePath, reducedGapSeconds);
        outputParts.push(silencePath);
      }

      fitDiagnostics = {
        ...(await fitMp3ToSlot(
          segmentRawMp3Path,
          segmentFittedMp3Path,
          effectiveSlotSeconds,
          rawTtsSeconds,
        )),
        effectiveSlotSeconds: roundSeconds(effectiveSlotSeconds),
        borrowedPauseBeforeSeconds: roundSeconds(borrowedPauseBeforeSeconds),
        borrowedPauseAfterSeconds: roundSeconds(borrowedPauseAfterSeconds),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      console.warn("[gemini-performance-script-poc] TTS segment failed; rendering slot as silence.", {
        index,
        id: segment.id,
        start: roundSeconds(segment.start),
        end: roundSeconds(segment.end),
        slotSeconds: roundSeconds(slotSeconds),
        error: message,
        text: (segment.ttsText || segment.translatedText || segment.sourceText).slice(0, 100),
      });

      throw error;
    }

    segmentDiagnostics.push({
      id: segment.id,
      start: roundSeconds(segment.start),
      end: roundSeconds(segment.end),
      slotSeconds: roundSeconds(slotSeconds),
      ...fitDiagnostics,
    });
    outputParts.push(segmentFittedMp3Path);
    cursor = Math.max(
      segment.end,
      segment.start - borrowedPauseBeforeSeconds + fitDiagnostics.finalSegmentSeconds,
    );

    console.info("[gemini-performance-script-poc] Segment slot timing diagnostics.", {
      index,
      id: segment.id,
      start: roundSeconds(segment.start),
      end: roundSeconds(segment.end),
      slotSeconds: roundSeconds(slotSeconds),
      ...fitDiagnostics,
      gapBeforeSeconds: roundSeconds(gapSeconds),
      gapAfterSeconds: roundSeconds(gapAfterSeconds),
    });
  }

  const tailSilenceSeconds = Math.max(0, originalDurationSeconds - cursor);

  if (tailSilenceSeconds >= 0.05) {
    const silencePath = join(tempDirectory, "silence-tail.mp3");

    await createSilenceMp3(silencePath, tailSilenceSeconds);
    outputParts.push(silencePath);
  }

  await concatMp3Files(outputParts, outputPath, tempDirectory);

  const finalOutputDurationSeconds = await runFfprobeDuration(outputPath);
  const diagnostics = {
    enabled: true,
    mode: "segment-slots",
    originalDurationSeconds: roundSeconds(originalDurationSeconds),
    finalOutputDurationSeconds: roundSeconds(finalOutputDurationSeconds),
    segmentCount: timelineSegments.length,
    segments: segmentDiagnostics.slice(0, 20),
  } satisfies DurationAlignmentDiagnostics;

  console.info("[gemini-performance-script-poc] Segment-slot render diagnostics.", {
    ...diagnostics,
    durationDeltaSeconds: roundSeconds(finalOutputDurationSeconds - originalDurationSeconds),
  });

  return diagnostics;
}

async function renderPerformanceScriptAudio(
  apiKey: string,
  script: GeminiPerformanceScript,
  targetLanguageLabel: string,
  originalAudioFile: File,
) {
  const tempDirectory = join(tmpdir(), `gemini-performance-script-render-${randomUUID()}`);
  const outputPath = join(tempDirectory, "gemini-performance-script-output.mp3");
  const rawOutputPath = join(tempDirectory, "gemini-performance-script-output-raw.mp3");

  await mkdir(tempDirectory, { recursive: true });

  try {
    const durationAlignment = await renderSegmentSlotAudio(
      apiKey,
      script,
      targetLanguageLabel,
      originalAudioFile,
      outputPath,
      tempDirectory,
    );

    if (durationAlignment) {
      return {
        audioBuffer: await readFile(outputPath),
        durationAlignment,
      };
    }

    const pcmPath = join(tempDirectory, "full-script.pcm");
    const audioBuffer = await generateFullScriptSpeechPcm(apiKey, script, targetLanguageLabel);

    await writeFile(pcmPath, audioBuffer);
    await convertPcmToMp3(pcmPath, rawOutputPath);

    return {
      audioBuffer: await readFile(rawOutputPath),
      durationAlignment: {
        enabled: false,
        mode: "single-take",
      } satisfies DurationAlignmentDiagnostics,
    };
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

  const renderedAudio = await renderPerformanceScriptAudio(
    apiKey,
    translatedPerformanceScript,
    targetLanguage.label,
    audioFile,
  );

  return {
    ...translatedPerformanceScript,
    audioBuffer: renderedAudio.audioBuffer,
    mimeType: "audio/mpeg",
    provider: "gemini-performance-script",
    targetLanguage: targetLanguage.code,
    durationAlignment: renderedAudio.durationAlignment,
    models: {
      script: scriptModel,
      tts: ttsModel,
    },
    notice:
      "Gemini performance-script POC: this uses Gemini audio understanding plus Gemini TTS. It aims to preserve emotion, interjections, pace, and delivery, but it does not clone or preserve the original speaker voice.",
  } satisfies GeminiPerformanceScriptDubbingResult;
}
