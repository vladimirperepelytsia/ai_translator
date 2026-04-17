import { MediaPlayer } from "@/components/media-player";
import {
  extractMediaDetails,
  getSingleValue,
  type MediaDetails,
  type SearchParamValue,
} from "@/lib/media";

type PageProps = {
  searchParams: Promise<{
    url?: SearchParamValue;
  }>;
};

export default async function Home({ searchParams }: PageProps) {
  const shareUrl = getSingleValue((await searchParams).url)?.trim() ?? "";

  let media: MediaDetails | null = null;
  let error: string | null = null;

  if (shareUrl) {
    try {
      media = await extractMediaDetails(shareUrl);
    } catch (caughtError) {
      error =
        caughtError instanceof Error
          ? caughtError.message
          : "Something went wrong while loading the media.";
    }
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,#1f3b54_0%,#08111d_40%,#04070b_100%)] px-6 py-10 text-white">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <section className="overflow-hidden rounded-[2rem] border border-white/10 bg-white/6 shadow-2xl shadow-black/40 backdrop-blur">
          <div className="grid gap-0 lg:grid-cols-[minmax(0,1.2fr)_minmax(24rem,0.8fr)]">
            <div className="border-b border-white/10 p-8 lg:border-r lg:border-b-0 lg:p-10">
              <p className="text-xs uppercase tracking-[0.35em] text-cyan-300/80">
                Video Extractor
              </p>
              <h1 className="mt-4 max-w-2xl text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                Paste a PT Live or YouTube link and play it with optional Ukrainian live dubbing.
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-white/70">
                Submit a PT Live shared recording URL to extract its MP4 source, or paste a YouTube
                URL to open it in an embedded player.
                {" "}
                Supported examples:
                {" "}
                <span className="text-white/90">
                  https://recordings.ptlive-sandbox.video/share/... or
                  {" "}
                  https://www.youtube.com/watch?v=...
                </span>
              </p>
            </div>

            <div className="p-8 lg:p-10">
              <form action="" className="space-y-4">
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-white/80">
                    Share or video URL
                  </span>
                  <input
                    type="url"
                    name="url"
                    defaultValue={shareUrl}
                    placeholder="https://recordings.ptlive-sandbox.video/share/... or https://youtu.be/..."
                    className="w-full rounded-2xl border border-white/15 bg-black/20 px-4 py-3 text-sm text-white outline-none ring-0 placeholder:text-white/35 focus:border-cyan-300/60"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </label>

                <button
                  type="submit"
                  className="inline-flex rounded-2xl bg-cyan-300 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200"
                >
                  Extract video
                </button>
              </form>

              <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
                PT Live links are fetched on the server to avoid CORS issues while reading the share
                page HTML. PT Live playback can also stream browser audio into an OpenAI Realtime
                session for English-to-Ukrainian voice translation. YouTube links are converted into
                a privacy-enhanced embed URL.
              </div>
            </div>
          </div>
        </section>

        {error ? (
          <section className="rounded-[2rem] border border-rose-400/25 bg-rose-500/10 p-6 text-rose-100">
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-rose-200/80">Error</p>
            <p className="mt-3 text-base">{error}</p>
          </section>
        ) : null}

        {media ? <MediaPlayer key={media.shareUrl} media={media} /> : null}
      </div>
    </main>
  );
}
