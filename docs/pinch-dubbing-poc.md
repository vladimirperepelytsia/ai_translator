# Pinch Audio-to-Audio Dubbing POC

## Goal

This POC tests real audio-to-audio dubbing for voice preservation, emotion, natural phrasing, timing, and output duration. It does not use TTS or translated text as the audio-generation control surface.

## Pipeline

1. Request a Pinch presigned upload URL.
2. Upload the local audio/video file to Pinch storage.
3. Create a Pinch dubbing job with `source_url`, `source_lang`, and `target_lang`.
4. Poll until the job is `completed` or `failed`.
5. Download the returned `output_url`.
6. Save the dubbed output under `public/pinch-dubbing-poc-output/`.
7. Detect short loud expressive events in the original audio and mix them quietly over the dubbed output.
8. Show original, clean Pinch output, and enhanced output side by side in the browser.

## Environment

```bash
PINCH_API_KEY=
PINCH_SOURCE_LANG=auto
PINCH_REDUCE_ACCENT=false
PINCH_TRANSLATION_LAG_TIME=0
PINCH_ORIGINAL_SPEECH_VOLUME=0
PINCH_POLL_INTERVAL_MS=5000
PINCH_POLL_TIMEOUT_MS=600000
EXPRESSIVE_OVERLAY_ENABLED=true
EXPRESSIVE_OVERLAY_THRESHOLD_DB=-18
EXPRESSIVE_OVERLAY_MIN_SILENCE_SECONDS=0.12
EXPRESSIVE_OVERLAY_MIN_EVENT_SECONDS=0.18
EXPRESSIVE_OVERLAY_MAX_EVENT_SECONDS=1.6
EXPRESSIVE_OVERLAY_EVENT_PADDING_SECONDS=0.12
EXPRESSIVE_OVERLAY_MAX_EVENTS=12
EXPRESSIVE_OVERLAY_VOLUME=0.9
EXPRESSIVE_OVERLAY_DUCK_DUB=true
EXPRESSIVE_OVERLAY_DUCK_VOLUME=0.18
EXPRESSIVE_OVERLAY_WINDOW_SECONDS=0.7
EXPRESSIVE_OVERLAY_WINDOW_STEP_SECONDS=0.25
EXPRESSIVE_OVERLAY_WINDOW_MIN_RMS_DB=-42
```

## Manual Test

```bash
npm run dev
```

Open:

```text
http://localhost:3000/pinch-dubbing-poc
```

Or use curl:

```bash
curl -X POST http://localhost:3000/api/pinch-dubbing-poc \
  -F "audio=@/absolute/path/to/sample.mp3" \
  -F "targetLanguage=es"
```

## Notes

- Pinch docs list a 10 minute max duration, 500 MB max file size, and typical processing time of 2-5 minutes for 1 minute of input.
- `PINCH_ORIGINAL_SPEECH_VOLUME=0` removes the original speech from the output; raise it if you want a mixed “live interpreter” feel.
- `PINCH_TRANSLATION_LAG_TIME=0` avoids adding extra delay to the dubbed speech.
- `PINCH_REDUCE_ACCENT=false` favors voice similarity over target-language accent reduction.
- Expressive overlay is a heuristic. It first uses `ffmpeg silencedetect` to find short non-silent peaks. If none are found, it falls back to short RMS/peak energy windows. It exports snippets for debugging, ducks the Pinch output during those windows, and mixes the original snippets over the dubbed output.
- If too many original-language fragments leak through, lower `EXPRESSIVE_OVERLAY_VOLUME`, lower `EXPRESSIVE_OVERLAY_MAX_EVENTS`, or raise `EXPRESSIVE_OVERLAY_THRESHOLD_DB` closer to `-12`.
- If the enhanced output still sounds identical, listen to the event snippets first. That tells us whether detection found the right expressive moments.
