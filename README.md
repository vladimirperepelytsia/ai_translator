# AI Translator

Next.js app for loading PT Live and YouTube videos, with browser-side live Ukrainian dubbing for PT Live playback.

## Run locally

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Static Auth

The app is protected with a simple cookie-backed login flow. Set `BASIC_AUTH_USERNAME` and `BASIC_AUTH_PASSWORD` in each deployed environment. In development, the auth gate stays disabled if those variables are missing so local work is not blocked; once they are set, the app will redirect unauthenticated users to `/login` and store an `httpOnly` session cookie after a successful sign-in.

## Live Translation Setup

Create a local env file from `.env.example` and set `OPENAI_API_KEY` before using the PT Live live-translation controls. PT Live translation now uses two persistent OpenAI Realtime sessions: one session continuously transcribes the English video audio, and a second session streams Ukrainian speech back over a live audio channel. If translation falls behind, older unsent phrases are dropped so playback stays closer to realtime.

## Scripts

```bash
npm run dev
npm run build
npm run start
npm run lint
```
