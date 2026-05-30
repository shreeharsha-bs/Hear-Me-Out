export const API_BASE = "";

export function getMeanvcWsUrl(targetId: string, sourceSr: number): string {
  const host = (import.meta as any).env?.VITE_MEANVC_HOST || "130.237.3.103";
  return `wss://${host}:5002/api/meanvc/stream?target_id=${targetId}&steps=8&source_sr=${sourceSr}`;
}

export function getMeanvcLoadTargetUrl(): string {
  const host = (import.meta as any).env?.VITE_MEANVC_HOST || "130.237.3.103";
  return `https://${host}:5002/api/meanvc/load-target`;
}

export function getPersonaplexWsURL(): string {
  const wsHost = (import.meta as any).env?.VITE_PERSONAPLEX_HOST || window.location.hostname;
  const voicePrompt = "NATF2.pt";
  const textPrompt = "You enjoy having a good conversation.";
  return `wss://${wsHost}:8000/api/chat?voice_prompt=${encodeURIComponent(voicePrompt)}&text_prompt=${encodeURIComponent(textPrompt)}`;
}