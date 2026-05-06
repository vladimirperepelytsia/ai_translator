# Gemini Performance Script Dubbing POC

Low-risk isolated POC for Gemini audio-understanding plus Gemini TTS translated dubbing.

## What it does

1. Accepts one uploaded audio file.
2. Sends the audio directly to Gemini audio understanding.
3. Requests a strict JSON performance script with a faithful transcript, clean translation,
   full `ttsText`, emotion, intensity, volume, pace, non-lexical cues, and one TTS prompt.
4. Renders the full translated performance once with Gemini TTS. This flow intentionally does not
   align timestamps, split segments, speed up speech, trim audio, or force original pause timing.
5. Converts Gemini's raw PCM output to MP3 with ffmpeg.
6. Saves the output under `public/gemini-performance-script-dubbing-poc-output/`.

## Environment

```bash
GEMINI_API_KEY=
GEMINI_PERFORMANCE_SCRIPT_MODEL=gemini-2.5-flash
GEMINI_PERFORMANCE_SCRIPT_FALLBACK_MODEL=gemini-2.5-flash-lite
GEMINI_PERFORMANCE_SCRIPT_MAX_OUTPUT_TOKENS=8192
GEMINI_PERFORMANCE_TTS_MODEL=gemini-3.1-flash-tts-preview
GEMINI_PERFORMANCE_TTS_SPEAKER=Orus
GEMINI_PERFORMANCE_TTS_CONTEXT=You are performing casino entertainment audio for a live casino game show audience.
GEMINI_PERFORMANCE_MAX_RETRIES=3
GEMINI_PERFORMANCE_RETRY_BASE_MS=1500
GEMINI_PERFORMANCE_MAX_RETRY_DELAY_MS=45000
```

This POC requires `ffmpeg` on the local PATH.

## Manual test

1. Add `GEMINI_API_KEY` to local env.
2. Run the app.
3. Open `/gemini-performance-script-dubbing-poc`.
4. Upload a short expressive clip.
5. Select the target language.
6. Submit and compare the original with the Gemini performance output.
7. Review the generated performance segments to verify whether Gemini captured interjections like
   `Фууух`, sighs, laughter, volume, and intensity. `ttsText` is the actual text sent to Gemini TTS
   and may include inline cues such as `[laughs]`, `[sigh]`, `[breathy]`, or `[excited]`.

## Limitations

- This is not voice cloning and does not preserve the original speaker voice.
- Emotion preservation is approximate and depends on Gemini's audio understanding plus TTS control.
- Gemini TTS returns raw 24 kHz PCM, which this POC converts locally with ffmpeg.
- The output is not timestamp-aligned to the original. It prioritizes a coherent emotional dub over
  matching the source duration or pause layout.
- This uses one Gemini TTS request per dub, which is cheaper and less quota-heavy than multi-request rendering.
