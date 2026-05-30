export const API_BASE = "";

// In Vite dev mode, route MeanVC through Vite proxy to avoid WSS cert issues
const isDev = (import.meta as any).env?.DEV || false;

export function getMeanvcWsUrl(targetId: string, sourceSr: number): string {
  if (isDev) {
    return `ws://${window.location.host}/meanvc/api/meanvc/stream?target_id=${targetId}&steps=8&source_sr=${sourceSr}`;
  }
  const host = (import.meta as any).env?.VITE_MEANVC_HOST || "localhost";
  return `wss://${host}:5002/api/meanvc/stream?target_id=${targetId}&steps=8&source_sr=${sourceSr}`;
}

export function getMeanvcLoadTargetUrl(): string {
  if (isDev) {
    return "/meanvc/api/meanvc/load-target";
  }
  const host = (import.meta as any).env?.VITE_MEANVC_HOST || "localhost";
  return `https://${host}:5002/api/meanvc/load-target`;
}

export function getPersonaplexWsURL(): string {
  const wsHost = (import.meta as any).env?.VITE_PERSONAPLEX_HOST || window.location.hostname;
  const voicePrompt = "NATF2.pt";
  const textPrompt = "You enjoy having a good conversation.";
  return `wss://${wsHost}:8000/api/chat?voice_prompt=${encodeURIComponent(voicePrompt)}&text_prompt=${encodeURIComponent(textPrompt)}`;
}