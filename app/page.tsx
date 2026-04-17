type SearchParamValue = string | string[] | undefined;

type PageProps = {
  searchParams: Promise<{
    url?: SearchParamValue;
  }>;
};

type VideoDetails = {
  shareUrl: string;
  videoUrl: string;
  title: string;
  posterUrl?: string;
  expiresAt?: string;
  createdAt?: string;
  dateFrom?: string;
  dateTo?: string;
};

const ALLOWED_HOSTS = new Set([
  "recordings.ptlive-sandbox.video",
  "recordings.ptlive.video",
]);

function getSingleValue(value: SearchParamValue) {
  return Array.isArray(value) ? value[0] : value;
}

function decodeHtml(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function stripTags(value: string) {
  return value.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function matchValue(html: string, pattern: RegExp) {
  const match = html.match(pattern);

  if (!match?.[1]) {
    return undefined;
  }

  return decodeHtml(stripTags(match[1]));
}

function getMetadataValue(html: string, label: string) {
  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return matchValue(
    html,
    new RegExp(
      `<div class="metadata-label">${escapedLabel}</div>\\s*<div class="metadata-value(?: expiry-warning)?">([\\s\\S]*?)</div>`,
      "i",
    ),
  );
}

function validateShareUrl(rawUrl: string) {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error("Enter a valid URL.");
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  if (!ALLOWED_HOSTS.has(parsedUrl.hostname) || !parsedUrl.pathname.startsWith("/share/")) {
    throw new Error(
      "Use a PT Live recording share link from recordings.ptlive-sandbox.video or recordings.ptlive.video.",
    );
  }

  return parsedUrl.toString();
}

async function extractVideoDetails(rawUrl: string): Promise<VideoDetails> {
  const shareUrl = validateShareUrl(rawUrl);
  const response = await fetch(shareUrl, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`Could not load the shared recording page (${response.status}).`);
  }

  const html = await response.text();
  const videoUrl = matchValue(html, /<source\s+src="([^"]+)"\s+type="video\/mp4"/i);

  if (!videoUrl) {
    throw new Error("No MP4 source was found on the shared recording page.");
  }

  return {
    shareUrl,
    videoUrl,
    posterUrl: matchValue(html, /<video[^>]*poster="([^"]*)"/i),
    title:
      matchValue(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) ??
      matchValue(html, /<title>([\s\S]*?)<\/title>/i) ??
      "Shared recording",
    expiresAt:
      getMetadataValue(html, "Expires On") ??
      matchValue(html, /This video will expire on ([^<]+)/i),
    createdAt: getMetadataValue(html, "Created"),
    dateFrom: getMetadataValue(html, "Date From"),
    dateTo: getMetadataValue(html, "Date To"),
  };
}

function Detail({
  label,
  value,
}: {
  label: string;
  value?: string;
}) {
  if (!value) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
      <p className="text-xs uppercase tracking-[0.2em] text-white/45">{label}</p>
      <p className="mt-2 text-sm text-white/90">{value}</p>
    </div>
  );
}

export default async function Home({ searchParams }: PageProps) {
  const shareUrl = getSingleValue((await searchParams).url)?.trim() ?? "";

  let video: VideoDetails | null = null;
  let error: string | null = null;

  if (shareUrl) {
    try {
      video = await extractVideoDetails(shareUrl);
    } catch (caughtError) {
      error =
        caughtError instanceof Error
          ? caughtError.message
          : "Something went wrong while extracting the video.";
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
                Paste a PT Live share link and play the extracted recording directly.
              </h1>
              <p className="mt-4 max-w-2xl text-base leading-7 text-white/70">
                Submit a shared recording URL like
                {" "}
                <span className="text-white/90">
                  https://recordings.ptlive-sandbox.video/share/...
                </span>
                {" "}
                and the page will fetch the share document, extract the MP4 source, and render it in
                a native player.
              </p>
            </div>

            <div className="p-8 lg:p-10">
              <form action="" className="space-y-4">
                <label className="block">
                  <span className="mb-2 block text-sm font-medium text-white/80">
                    Recording share URL
                  </span>
                  <input
                    type="url"
                    name="url"
                    defaultValue={shareUrl}
                    placeholder="https://recordings.ptlive-sandbox.video/share/..."
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
                The fetch runs on the server, which avoids browser CORS issues when reading the share
                page HTML.
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

        {video ? (
          <section className="overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/80 shadow-2xl shadow-black/40">
            <div className="border-b border-white/10 px-6 py-5 sm:px-8">
              <p className="text-xs uppercase tracking-[0.25em] text-cyan-300/80">Loaded Video</p>
              <h2 className="mt-2 text-2xl font-semibold text-white">{video.title}</h2>
              <p className="mt-2 text-sm text-white/60">{video.shareUrl}</p>
            </div>

            <div className="aspect-video bg-black">
              <video
                key={video.videoUrl}
                controls
                playsInline
                preload="metadata"
                poster={video.posterUrl}
                className="h-full w-full"
              >
                <source src={video.videoUrl} type="video/mp4" />
                Your browser does not support the video tag.
              </video>
            </div>

            <div className="grid gap-4 px-6 py-6 sm:grid-cols-2 xl:grid-cols-4 sm:px-8">
              <Detail label="Created" value={video.createdAt} />
              <Detail label="Date From" value={video.dateFrom} />
              <Detail label="Date To" value={video.dateTo} />
              <Detail label="Expires On" value={video.expiresAt} />
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
