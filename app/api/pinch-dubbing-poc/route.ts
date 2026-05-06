import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import { extname, join } from "path";
import { NextResponse } from "next/server";
import {
  isStaticAuthConfigured,
  isStaticAuthRequestAuthorized,
  shouldBypassStaticAuth,
} from "@/lib/static-auth";
import { applyExpressiveOverlay } from "@/lib/expressive-overlay";
import { dubAudioWithPinch } from "@/lib/pinch-dubbing-poc";

export const runtime = "nodejs";

const outputDirectoryName = "pinch-dubbing-poc-output";
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

function getOutputExtension(mimeType: string) {
  if (mimeType.includes("wav")) {
    return ".wav";
  }

  if (mimeType.includes("mp4")) {
    return ".mp4";
  }

  return ".mp3";
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
    console.error("[pinch-dubbing-poc] Could not read multipart form data.", error);
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
    const result = await dubAudioWithPinch(
      audioFile,
      typeof formData.get("targetLanguage") === "string"
        ? (formData.get("targetLanguage") as string)
        : null,
    );
    const originalBuffer = Buffer.from(await audioFile.arrayBuffer());
    const enhancedResult = await applyExpressiveOverlay(originalBuffer, result.audioBuffer);
    const originalExtension = extname(audioFile.name);
    const outputExtension = getOutputExtension(result.mimeType) || originalExtension || ".mp3";
    const outputFileName = `pinch-dubbing-${result.targetLanguage}-${randomUUID()}${outputExtension}`;
    const enhancedOutputFileName = `pinch-dubbing-enhanced-${
      result.targetLanguage
    }-${randomUUID()}.mp3`;
    const eventId = randomUUID();
    const outputPath = join(publicOutputDirectory, outputFileName);
    const enhancedOutputPath = join(publicOutputDirectory, enhancedOutputFileName);
    const outputUrl = `/${outputDirectoryName}/${outputFileName}`;
    const enhancedOutputUrl = `/${outputDirectoryName}/${enhancedOutputFileName}`;
    const overlayEvents = enhancedResult.events.map((event, index) => {
      const eventFileName = `pinch-expressive-event-${eventId}-${index}.mp3`;

      return {
        start: event.start,
        end: event.end,
        duration: event.duration,
        audioPath: join(publicOutputDirectory, eventFileName),
        audioUrl: `/${outputDirectoryName}/${eventFileName}`,
        audioBuffer: event.audioBuffer,
      };
    });

    await mkdir(publicOutputDirectory, { recursive: true });
    await writeFile(outputPath, result.audioBuffer);
    await writeFile(enhancedOutputPath, enhancedResult.audioBuffer);
    await Promise.all(
      overlayEvents.map((event) =>
        event.audioBuffer ? writeFile(event.audioPath, event.audioBuffer) : Promise.resolve(),
      ),
    );

    console.info("[pinch-dubbing-poc] Saved Pinch dubbed output.", {
      outputPath,
      enhancedOutputPath,
      outputUrl,
      enhancedOutputUrl,
      jobId: result.job.job_id,
      overlayEvents: overlayEvents.length,
    });

    return NextResponse.json({
      audioPath: outputPath,
      audioUrl: outputUrl,
      enhancedAudioPath: enhancedOutputPath,
      enhancedAudioUrl: enhancedOutputUrl,
      overlayEvents: overlayEvents.map((event) => ({
        start: event.start,
        end: event.end,
        duration: event.duration,
        audioPath: event.audioPath,
        audioUrl: event.audioUrl,
      })),
      overlaySkippedReason: enhancedResult.skippedReason,
      mimeType: result.mimeType,
      enhancedMimeType: enhancedResult.mimeType,
      provider: result.provider,
      targetLanguage: result.targetLanguage,
      job: result.job,
      originalOutputUrl: result.outputUrl,
      notice: result.notice,
    });
  } catch (error) {
    console.error("[pinch-dubbing-poc] Failed to dub audio.", error);

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Pinch dubbing POC failed.",
      },
      { status: 500 },
    );
  }
}
