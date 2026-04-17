import { NextRequest, NextResponse } from "next/server";
import { extractPTLiveDetails, parseSupportedUrl } from "@/lib/media";

const FORWARDED_HEADERS = [
  "accept-ranges",
  "cache-control",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
] as const;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const shareUrl = request.nextUrl.searchParams.get("shareUrl");

  if (!shareUrl) {
    return NextResponse.json({ error: "Missing shareUrl." }, { status: 400 });
  }

  try {
    const parsedUrl = parseSupportedUrl(shareUrl);
    const media = await extractPTLiveDetails(parsedUrl);
    const upstreamHeaders = new Headers();
    const range = request.headers.get("range");

    if (range) {
      upstreamHeaders.set("range", range);
    }

    const upstreamResponse = await fetch(media.videoUrl, {
      cache: "no-store",
      headers: upstreamHeaders,
    });

    if (!upstreamResponse.ok && upstreamResponse.status !== 206) {
      return NextResponse.json(
        { error: `Could not load the PT Live video stream (${upstreamResponse.status}).` },
        { status: upstreamResponse.status },
      );
    }

    const responseHeaders = new Headers();

    FORWARDED_HEADERS.forEach((header) => {
      const value = upstreamResponse.headers.get(header);

      if (value) {
        responseHeaders.set(header, value);
      }
    });

    responseHeaders.set("content-disposition", "inline");

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Something went wrong while proxying the video.";

    return NextResponse.json({ error: message }, { status: 400 });
  }
}

