import { getTranslationLanguageConfig, type TranslationLanguage } from "@/lib/translation-languages";

type PinchUploadUrlResponse = {
  upload_url?: string;
  source_url?: string;
  upload_id?: string;
  max_file_size_bytes?: number;
  expires_in_sec?: number;
  error?: string;
};

type PinchUploadUrl = PinchUploadUrlResponse & {
  upload_url: string;
  source_url: string;
};

type PinchJobResponse = {
  job_id?: string;
  status?: string;
  source_lang?: string;
  target_lang?: string;
  error?: string | null;
  progress?: {
    stage?: string;
    stage_name?: string;
    percent?: number;
  };
  input_duration_sec?: number;
  cost_usd?: number;
  output_url?: string | null;
  output_expires_at?: string | null;
  created_at?: string;
  updated_at?: string;
  limits?: {
    max_duration_sec?: number;
    max_file_size_bytes?: number;
  };
};

type PinchCreatedJob = PinchJobResponse & {
  job_id: string;
};

export type PinchDubbingResult = {
  audioBuffer: Buffer;
  mimeType: string;
  provider: "pinch";
  job: PinchJobResponse;
  targetLanguage: TranslationLanguage;
  outputUrl: string;
  notice: string;
};

const PINCH_BASE_URL = "https://api.startpinch.com";
const PINCH_LANGUAGE_BY_TRANSLATION_LANGUAGE: Record<TranslationLanguage, string> = {
  es: "es",
  fr: "fr",
  it: "it",
  de: "de",
};

function getNumberEnv(name: string, fallback: number) {
  const value = Number(process.env[name]);

  return Number.isFinite(value) ? value : fallback;
}

function getBooleanEnv(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();

  if (value === "true" || value === "1") {
    return true;
  }

  if (value === "false" || value === "0") {
    return false;
  }

  return fallback;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function readJsonResponse<T>(response: Response, fallbackMessage: string) {
  const payload = (await response.json().catch(() => null)) as (T & { error?: string }) | null;

  if (!response.ok) {
    throw new Error(payload?.error ?? fallbackMessage);
  }

  if (!payload) {
    throw new Error(fallbackMessage);
  }

  return payload;
}

function authHeaders(apiKey: string) {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

async function createUploadUrl(apiKey: string, audioFile: File): Promise<PinchUploadUrl> {
  console.info("[pinch-dubbing-poc] Requesting upload URL.", {
    filename: audioFile.name,
    contentType: audioFile.type,
    bytes: audioFile.size,
  });

  const response = await fetch(`${PINCH_BASE_URL}/api/dubbing/upload-url`, {
    method: "POST",
    headers: {
      ...authHeaders(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      filename: audioFile.name || "source-audio.mp3",
      content_type: audioFile.type || "audio/mpeg",
    }),
  });
  const payload = await readJsonResponse<PinchUploadUrlResponse>(
    response,
    "Pinch upload URL request failed.",
  );

  if (!payload.upload_url || !payload.source_url) {
    throw new Error("Pinch upload URL response was missing upload_url or source_url.");
  }

  return {
    ...payload,
    upload_url: payload.upload_url,
    source_url: payload.source_url,
  };
}

async function uploadMediaToPinch(uploadUrl: string, audioFile: File) {
  console.info("[pinch-dubbing-poc] Uploading media to Pinch storage.");

  const response = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": audioFile.type || "audio/mpeg",
    },
    body: await audioFile.arrayBuffer(),
  });

  if (!response.ok) {
    throw new Error((await response.text()) || "Pinch media upload failed.");
  }
}

async function createDubbingJob(
  apiKey: string,
  sourceUrl: string,
  targetLang: string,
): Promise<PinchCreatedJob> {
  const sourceLang = process.env.PINCH_SOURCE_LANG ?? "auto";
  const reduceAccent = getBooleanEnv("PINCH_REDUCE_ACCENT", false);
  const translationLagTime = getNumberEnv("PINCH_TRANSLATION_LAG_TIME", 0);
  const originalSpeechVolume = getNumberEnv("PINCH_ORIGINAL_SPEECH_VOLUME", 0);

  console.info("[pinch-dubbing-poc] Creating dubbing job.", {
    sourceLang,
    targetLang,
    reduceAccent,
    translationLagTime,
    originalSpeechVolume,
  });

  const response = await fetch(`${PINCH_BASE_URL}/api/dubbing/jobs`, {
    method: "POST",
    headers: {
      ...authHeaders(apiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source_url: sourceUrl,
      source_lang: sourceLang,
      target_lang: targetLang,
      reduce_accent: reduceAccent,
      translation_lag_time: translationLagTime,
      original_speech_volume: originalSpeechVolume,
    }),
  });
  const payload = await readJsonResponse<PinchJobResponse>(
    response,
    "Pinch dubbing job creation failed.",
  );

  if (!payload.job_id) {
    throw new Error("Pinch dubbing job response was missing job_id.");
  }

  return {
    ...payload,
    job_id: payload.job_id,
  };
}

async function getDubbingJob(apiKey: string, jobId: string) {
  const response = await fetch(`${PINCH_BASE_URL}/api/dubbing/jobs/${jobId}`, {
    headers: authHeaders(apiKey),
  });

  return readJsonResponse<PinchJobResponse>(response, "Pinch dubbing job polling failed.");
}

async function waitForDubbingJob(apiKey: string, jobId: string) {
  const timeoutMs = getNumberEnv("PINCH_POLL_TIMEOUT_MS", 10 * 60 * 1000);
  const intervalMs = getNumberEnv("PINCH_POLL_INTERVAL_MS", 5000);
  const startedAt = Date.now();
  let latestJob: PinchJobResponse | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    latestJob = await getDubbingJob(apiKey, jobId);

    console.info("[pinch-dubbing-poc] Dubbing job status.", {
      jobId,
      status: latestJob.status,
      progress: latestJob.progress,
    });

    if (latestJob.status === "completed") {
      if (!latestJob.output_url) {
        throw new Error("Pinch job completed without output_url.");
      }

      return latestJob;
    }

    if (latestJob.status === "failed") {
      throw new Error(latestJob.error ?? "Pinch dubbing job failed.");
    }

    await wait(intervalMs);
  }

  throw new Error(
    `Pinch dubbing job timed out after ${Math.round(timeoutMs / 1000)} seconds. Last status: ${
      latestJob?.status ?? "unknown"
    }.`,
  );
}

async function downloadDubbedOutput(outputUrl: string) {
  console.info("[pinch-dubbing-poc] Downloading dubbed output.");

  const response = await fetch(outputUrl);

  if (!response.ok) {
    throw new Error((await response.text()) || "Pinch dubbed output download failed.");
  }

  return {
    audioBuffer: Buffer.from(await response.arrayBuffer()),
    mimeType: response.headers.get("content-type") ?? "audio/mpeg",
  };
}

export async function dubAudioWithPinch(
  audioFile: File,
  targetLanguageValue: string | null | undefined,
) {
  const apiKey = process.env.PINCH_API_KEY;

  if (!apiKey) {
    throw new Error("Missing PINCH_API_KEY.");
  }

  const targetLanguage = getTranslationLanguageConfig(targetLanguageValue);
  const targetLang = PINCH_LANGUAGE_BY_TRANSLATION_LANGUAGE[targetLanguage.code];
  const upload = await createUploadUrl(apiKey, audioFile);

  await uploadMediaToPinch(upload.upload_url, audioFile);

  const createdJob = await createDubbingJob(apiKey, upload.source_url, targetLang);
  const completedJob = await waitForDubbingJob(apiKey, createdJob.job_id);
  const outputUrl = completedJob.output_url;

  if (!outputUrl) {
    throw new Error("Pinch completed job was missing output_url.");
  }

  const output = await downloadDubbedOutput(outputUrl);

  return {
    ...output,
    provider: "pinch",
    job: completedJob,
    targetLanguage: targetLanguage.code,
    outputUrl,
    notice:
      "Pinch dubbing POC: this is an audio-to-audio dubbing job with voice preservation. Use only with consent/rights to preserve speaker voice.",
  } satisfies PinchDubbingResult;
}
