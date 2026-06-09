export const API_BASE = "";

export function getMeanvcWsUrl(targetId: string, sourceSr: number, steps: number = 8): string {
  const host = (import.meta as any).env?.VITE_MEANVC_HOST || "130.237.3.103";
  return `wss://${host}:5002/api/meanvc/stream?target_id=${targetId}&steps=${steps}&source_sr=${sourceSr}`;
}

export function getMeanvcLoadTargetUrl(): string {
  const host = (import.meta as any).env?.VITE_MEANVC_HOST || "130.237.3.103";
  return `https://${host}:5002/api/meanvc/load-target`;
}

// Server-side VC bridge: the browser talks to MeanVC, which converts the mic
// audio and forwards it to PersonaPlex over localhost (no browser round trip).
// The returned socket speaks PersonaPlex's framing (0x00/0x01/0x02) plus 0x03
// for the converted user voice used by downloads.
export function getChatProxyWsUrl(
  targetId: string,
  sourceSr: number,
  steps: number,
  textPrompt: string,
  voicePrompt: string = "NATF2.pt",
): string {
  const host = (import.meta as any).env?.VITE_MEANVC_HOST || "130.237.3.103";
  const params = new URLSearchParams({
    target_id: targetId,
    steps: String(steps),
    source_sr: String(sourceSr),
    text_prompt: textPrompt,
    voice_prompt: voicePrompt,
  });
  return `wss://${host}:5002/api/meanvc/chat-proxy?${params.toString()}`;
}

const DEFAULT_PROMPT = "You enjoy having a good conversation.";

export function getPersonaplexWsURL(textPrompt?: string): string {
  // Allow override via URL query param (?personaplex_ws=ws://...)
  const override = new URLSearchParams(window.location.search).get("personaplex_ws");
  if (override) return override;
  const wsHost = (import.meta as any).env?.VITE_PERSONAPLEX_HOST || window.location.hostname;
  const voicePrompt = "NATF2.pt";
  const tp = textPrompt || DEFAULT_PROMPT;
  return `wss://${wsHost}:8000/api/chat?voice_prompt=${encodeURIComponent(voicePrompt)}&text_prompt=${encodeURIComponent(tp)}`;
}