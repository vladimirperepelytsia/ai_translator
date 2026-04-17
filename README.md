# AI Translator

Next.js app for loading PT Live and YouTube videos, with browser-side live Ukrainian dubbing for PT Live playback.

## Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Live Translation Setup

Create a local env file from `.env.example` and set `OPENAI_API_KEY` before using the PT Live live-translation controls. PT Live translation runs as a queued pipeline: English phrases are transcribed live, translated to Ukrainian, synthesized with TTS, and played sequentially so each spoken phrase can finish cleanly.

## Scripts

```bash
npm run dev
npm run build
npm run start
npm run lint
```
