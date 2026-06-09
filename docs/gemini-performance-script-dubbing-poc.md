# Gemini Performance Script Dubbing POC

Low-risk isolated POC for Gemini audio-understanding plus Gemini TTS translated dubbing.

## What it does

1. Accepts one uploaded audio file.
2. Splits long audio into script-analysis chunks, defaulting to 60 seconds.
3. Sends each chunk directly to Gemini audio understanding.
4. Requests strict JSON performance scripts with faithful transcripts, clean translations,
   full `ttsText`, inferred noticeable pause cues, emotion, intensity, volume, pace, non-lexical
   cues, timestamps, and TTS prompts.
5. Merges chunk timelines into one full-audio timeline.
6. Renders each translated reply separately with Gemini TTS.
7. Fits each rendered reply into the matching original source time slot.
8. Inserts source-derived silence between reply slots and concatenates the final MP3.
9. Saves the output under `public/gemini-performance-script-dubbing-poc-output/`.

## Environment

```bash
GEMINI_API_KEY=
GEMINI_PERFORMANCE_SCRIPT_MODEL=gemini-2.5-flash
GEMINI_PERFORMANCE_SCRIPT_FALLBACK_MODEL=gemini-2.5-flash-lite
GEMINI_PERFORMANCE_SCRIPT_MAX_OUTPUT_TOKENS=8192
GEMINI_PERFORMANCE_TTS_MODEL=gemini-3.1-flash-tts-preview
GEMINI_PERFORMANCE_TTS_SPEAKER=Charon
GEMINI_PERFORMANCE_TTS_CONTEXT=You are performing casino entertainment audio for a live casino game show audience.
GEMINI_PERFORMANCE_MAX_RETRIES=3
GEMINI_PERFORMANCE_RETRY_BASE_MS=1500
GEMINI_PERFORMANCE_MAX_RETRY_DELAY_MS=45000
GEMINI_PERFORMANCE_SCRIPT_CHUNK_SECONDS=60
GEMINI_PERFORMANCE_MIN_SCRIPT_CHUNK_SECONDS=30
GEMINI_PERFORMANCE_MIN_TTS_SLOT_SECONDS=3
GEMINI_PERFORMANCE_TINY_SEGMENT_MERGE_GAP_SECONDS=1
GEMINI_PERFORMANCE_MAX_SEGMENTS=8
GEMINI_PERFORMANCE_SEGMENT_MAX_SPEED_UP=1.3
GEMINI_PERFORMANCE_TARGET_SEGMENT_SPEED_UP=1.35
GEMINI_PERFORMANCE_MAX_PAUSE_BORROW_RATIO=1
GEMINI_PERFORMANCE_MAX_PAUSE_BORROW_SECONDS=4
GEMINI_PERFORMANCE_MIN_REMAINING_PAUSE_SECONDS=0
GEMINI_PERFORMANCE_MIN_TIMELINE_COVERAGE=0.85
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
   and may include inline cues such as `[laughs]`, `[sigh]`, `[breathy]`, `[pause 900]`, or
   `[excited]`.

## Limitations

- This is not voice cloning and does not preserve the original speaker voice.
- Emotion preservation is approximate and depends on Gemini's audio understanding plus TTS control.
- Gemini TTS returns raw 24 kHz PCM, which this POC converts locally with ffmpeg.
- Long audio is analyzed in chunks controlled by `GEMINI_PERFORMANCE_SCRIPT_CHUNK_SECONDS`. If a
  chunk still returns invalid JSON, it can be split again down to
  `GEMINI_PERFORMANCE_MIN_SCRIPT_CHUNK_SECONDS`. This avoids oversized JSON responses but increases
  script request count.
- Each reply is locally fit near its original source slot. If translated TTS is longer than the
  slot, the renderer first borrows limited silence from the neighboring pauses so speech can stay
  closer to `GEMINI_PERFORMANCE_TARGET_SEGMENT_SPEED_UP`. Remaining overflow is sped up up to
  `GEMINI_PERFORMANCE_SEGMENT_MAX_SPEED_UP`; if it is still too long, the segment is allowed to
  overrun its original slot instead of clipping the phrase ending.
- Pause borrowing is capped by `GEMINI_PERFORMANCE_MAX_PAUSE_BORROW_RATIO`,
  `GEMINI_PERFORMANCE_MAX_PAUSE_BORROW_SECONDS`, and
  `GEMINI_PERFORMANCE_MIN_REMAINING_PAUSE_SECONDS`, so long source pauses can be shortened or fully
  consumed when that keeps translated speech closer to natural speed.
- Very short TTS slots are merged into adjacent segments before rendering. The threshold is
  controlled by `GEMINI_PERFORMANCE_MIN_TTS_SLOT_SECONDS`.
- If Gemini returns a script that ends too early, the POC requests one extra script repair before
  spending TTS requests. The threshold is controlled by `GEMINI_PERFORMANCE_MIN_TIMELINE_COVERAGE`.
- This uses one Gemini TTS request per rendered segment, so it spends more quota than single-take
  rendering. Lower `GEMINI_PERFORMANCE_MAX_SEGMENTS` to reduce requests.
