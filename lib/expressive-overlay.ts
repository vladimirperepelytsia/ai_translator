type ExpressiveOverlayEvent = {
  start: number;
  end: number;
  duration: number;
  audioBuffer?: Buffer;
};

export async function applyExpressiveOverlay(
  _originalAudioBuffer: Buffer,
  dubbedAudioBuffer: Buffer,
): Promise<{
  audioBuffer: Buffer;
  events: ExpressiveOverlayEvent[];
  mimeType: "audio/mpeg";
  skippedReason: string;
}> {
  return {
    audioBuffer: dubbedAudioBuffer,
    events: [],
    mimeType: "audio/mpeg",
    skippedReason: "Expressive overlay is disabled in this low-risk fallback module.",
  };
}
