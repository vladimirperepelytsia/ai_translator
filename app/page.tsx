type SearchParamValue = string | string[] | undefined;

type PageProps = {
  searchParams: Promise<{
    url?: SearchParamValue;
  }>;
};

type PTLiveVideoDetails = {
  kind: "ptlive";
  shareUrl: string;
  videoUrl: string;
  title: string;
  posterUrl?: string;
  expiresAt?: string;
  createdAt?: string;
  dateFrom?: string;
  dateTo?: string;
};

type YouTubeVideoDetails = {
  kind: "youtube";
  shareUrl: string;
  embedUrl: string;
  title: string;
  videoId: string;
  startAt?: number;
};

type MediaDetails = PTLiveVideoDetails | YouTubeVideoDetails;

const PTLIVE_HOSTS = new Set([
  "recordings.ptlive-sandbox.video",
  "recordings.ptlive.video",
]);

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
]);

function getSingleValue(value: SearchParamValue) {
  return Array.isArray(value) ? value[0] : value;
}

function normalizeHostname(hostname: string) {
  return hostname.replace(/^(?:www\.|m\.)/, "");
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

function parseSupportedUrl(rawUrl: string) {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error("Enter a valid URL.");
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  return parsedUrl;
}

async function extractPTLiveDetails(parsedUrl: URL): Promise<PTLiveVideoDetails> {
  const hostname = normalizeHostname(parsedUrl.hostname);

  if (!PTLIVE_HOSTS.has(hostname) || !parsedUrl.pathname.startsWith("/share/")) {
    throw new Error(
      "Use a PT Live recording share link from recordings.ptlive-sandbox.video or recordings.ptlive.video.",
    );
  }

  const shareUrl = parsedUrl.toString();
  const response = await fetch(shareUrl, { cache: "no-store" });

  if (!response.ok) {
    throw new Error(`Could not load the shared recording page (${response.status}).`);
  }

  const html = await response.text();
  const videoUrl = matchValue(html, /<source[^>]+src="([^"]+)"[^>]+type="video\/mp4"/i);

  if (!videoUrl) {
    throw new Error("No MP4 source was found on the shared recording page.");
  }

  return {
    kind: "ptlive",
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

function parseYouTubeTimecode(value: string | null) {
  if (!value) {
    return undefined;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);

  if (!match) {
    return undefined;
  }

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  const total = hours * 3600 + minutes * 60 + seconds;

  return total > 0 ? total : undefined;
}

function formatSeconds(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function isValidYouTubeId(value: string | null | undefined): value is string {
  return Boolean(value && /^[A-Za-z0-9_-]{11}$/.test(value));
}

function getYouTubeVideoId(parsedUrl: URL) {
  const hostname = normalizeHostname(parsedUrl.hostname);
  const pathSegments = parsedUrl.pathname.split("/").filter(Boolean);

  if (hostname === "youtu.be") {
    return pathSegments[0];
  }

  if (hostname !== "youtube.com" && hostname !== "youtube-nocookie.com") {
    return undefined;
  }

  if (parsedUrl.pathname === "/watch") {
    return parsedUrl.searchParams.get("v") ?? undefined;
  }

  const [firstSegment, secondSegment] = pathSegments;

  if (["embed", "shorts", "live", "v"].includes(firstSegment ?? "")) {
    return secondSegment;
  }

  return undefined;
}

function extractYouTubeDetails(parsedUrl: URL): YouTubeVideoDetails {
  const hostname = normalizeHostname(parsedUrl.hostname);

  if (!YOUTUBE_HOSTS.has(hostname)) {
    throw new Error("Use a valid YouTube URL.");
  }

  const videoId = getYouTubeVideoId(parsedUrl);

  if (!isValidYouTubeId(videoId)) {
    throw new Error("Could not determine the YouTube video ID from that URL.");
  }

  const startAt =
    parseYouTubeTimecode(parsedUrl.searchParams.get("start")) ??
    parseYouTubeTimecode(parsedUrl.searchParams.get("t")) ??
    parseYouTubeTimecode(parsedUrl.hash.startsWith("#t=") ? parsedUrl.hash.slice(3) : null);
  const embedParams = new URLSearchParams({
    rel: "0",
    modestbranding: "1",
  });

  if (startAt) {
    embedParams.set("start", String(startAt));
  }

  return {
    kind: "youtube",
    shareUrl: parsedUrl.toString(),
    embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?${embedParams.toString()}`,
    title: "YouTube Video",
    videoId,
    startAt,
  };
}

async function extractMediaDetails(rawUrl: string): Promise<MediaDetails> {
  const parsedUrl = parseSupportedUrl(rawUrl);
  const hostname = normalizeHostname(parsedUrl.hostname);

  if (PTLIVE_HOSTS.has(hostname)) {
    return extractPTLiveDetails(parsedUrl);
  }

  if (YOUTUBE_HOSTS.has(hostname)) {
    return extractYouTubeDetails(parsedUrl);
  }

  throw new Error(
    "Use either a PT Live share link or a YouTube URL.",
  );
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
                Paste a PT Live or YouTube link and play the result directly.
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
                page HTML. YouTube links are converted into a privacy-enhanced embed URL.
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

        {media ? (
          <section className="overflow-hidden rounded-[2rem] border border-white/10 bg-slate-950/80 shadow-2xl shadow-black/40">
            <div className="border-b border-white/10 px-6 py-5 sm:px-8">
              <p className="text-xs uppercase tracking-[0.25em] text-cyan-300/80">Loaded Media</p>
              <h2 className="mt-2 text-2xl font-semibold text-white">{media.title}</h2>
              <p className="mt-2 text-sm text-white/60">{media.shareUrl}</p>
            </div>

            <div className="aspect-video bg-black">
              {media.kind === "ptlive" ? (
                <video
                  key={media.videoUrl}
                  controls
                  playsInline
                  preload="metadata"
                  poster={media.posterUrl}
                  className="h-full w-full"
                >
                  <source src={media.videoUrl} type="video/mp4" />
                  Your browser does not support the video tag.
                </video>
              ) : (
                <iframe
                  key={media.embedUrl}
                  src={media.embedUrl}
                  title={media.title}
                  className="h-full w-full"
                  referrerPolicy="strict-origin-when-cross-origin"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                />
              )}
            </div>

            <div className="grid gap-4 px-6 py-6 sm:grid-cols-2 xl:grid-cols-4 sm:px-8">
              <Detail
                label="Platform"
                value={media.kind === "ptlive" ? "PT Live" : "YouTube"}
              />
              {media.kind === "ptlive" ? (
                <>
                  <Detail label="Created" value={media.createdAt} />
                  <Detail label="Date From" value={media.dateFrom} />
                  <Detail label="Date To" value={media.dateTo} />
                  <Detail label="Expires On" value={media.expiresAt} />
                </>
              ) : (
                <>
                  <Detail label="Video ID" value={media.videoId} />
                  <Detail
                    label="Start At"
                    value={media.startAt ? formatSeconds(media.startAt) : undefined}
                  />
                </>
              )}
            </div>
          </section>
        ) : null}
      </div>
    </main>
  );
}
