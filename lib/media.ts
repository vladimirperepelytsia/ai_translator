export type SearchParamValue = string | string[] | undefined;

export type PTLiveVideoDetails = {
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

export type YouTubeVideoDetails = {
  kind: "youtube";
  shareUrl: string;
  embedUrl: string;
  title: string;
  videoId: string;
  startAt?: number;
};

export type MediaDetails = PTLiveVideoDetails | YouTubeVideoDetails;

export const PTLIVE_HOSTS = new Set([
  "recordings.ptlive-sandbox.video",
  "recordings.ptlive.video",
]);

export const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
]);

export function getSingleValue(value: SearchParamValue) {
  return Array.isArray(value) ? value[0] : value;
}

export function normalizeHostname(hostname: string) {
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

export function parseSupportedUrl(rawUrl: string) {
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

export async function extractPTLiveDetails(parsedUrl: URL): Promise<PTLiveVideoDetails> {
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

export function formatSeconds(totalSeconds: number) {
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

export function extractYouTubeDetails(parsedUrl: URL): YouTubeVideoDetails {
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

export async function extractMediaDetails(rawUrl: string): Promise<MediaDetails> {
  const parsedUrl = parseSupportedUrl(rawUrl);
  const hostname = normalizeHostname(parsedUrl.hostname);

  if (PTLIVE_HOSTS.has(hostname)) {
    return extractPTLiveDetails(parsedUrl);
  }

  if (YOUTUBE_HOSTS.has(hostname)) {
    return extractYouTubeDetails(parsedUrl);
  }

  throw new Error("Use either a PT Live share link or a YouTube URL.");
}

export function getPTLiveProxyUrl(shareUrl: string) {
  return `/api/ptlive/video?shareUrl=${encodeURIComponent(shareUrl)}`;
}
