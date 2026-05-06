import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { NextResponse } from "next/server";
import {
  isStaticAuthConfigured,
  isStaticAuthRequestAuthorized,
  shouldBypassStaticAuth,
} from "@/lib/static-auth";
import { dubAudioWithGeminiPerformanceScript } from "@/lib/gemini-performance-script-dubbing-poc";

export const runtime = "nodejs";

const outputDirectoryName = "gemini-performance-script-dubbing-poc-output";
const publicOutputDirectory = join(process.cwd(), "public", outputDirectoryName);

function isFile(value: FormDataEntryValue | null): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    "arrayBuffer" in value &&
    "name" in value &&
    "size" in value
  );
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

  const formData = await request.formData().catch((error) => {
    console.error("[gemini-performance-script-poc] Could not read multipart form data.", error);
    return null;
  });

  if (!formData) {
    return NextResponse.json({ error: "Expected multipart form data." }, { status: 400 });
  }

  const audioFile = formData.get("audio");

  if (!isFile(audioFile) || audioFile.size === 0) {
    return NextResponse.json({ error: "Missing audio file field named `audio`." }, { status: 400 });
  }

  try {
    const result = await dubAudioWithGeminiPerformanceScript(
      audioFile,
      typeof formData.get("targetLanguage") === "string"
        ? (formData.get("targetLanguage") as string)
        : null,
    );
    const outputFileName = `gemini-performance-script-${
      result.targetLanguage
    }-${randomUUID()}.mp3`;
    const outputPath = join(publicOutputDirectory, outputFileName);
    const outputUrl = `/${outputDirectoryName}/${outputFileName}`;

    await mkdir(publicOutputDirectory, { recursive: true });
    await writeFile(outputPath, result.audioBuffer);

    console.info("[gemini-performance-script-poc] Saved dubbed audio.", {
      outputPath,
      outputUrl,
      segments: result.segments.length,
    });

    return NextResponse.json({
      originalTranscript: result.originalTranscript,
      translatedText: result.translatedText,
      segments: result.segments,
      audioPath: outputPath,
      audioUrl: outputUrl,
      mimeType: result.mimeType,
      provider: result.provider,
      targetLanguage: result.targetLanguage,
      models: result.models,
      notice: result.notice,
    });
  } catch (error) {
    console.error("[gemini-performance-script-poc] Failed to dub audio.", error);

    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Gemini performance-script dubbing POC failed.",
      },
      { status: 500 },
    );
  }
}
