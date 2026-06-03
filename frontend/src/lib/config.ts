export const API_BASE = "";

export function getMeanvcWsUrl(targetId: string, sourceSr: number, steps: number = 8): string {
  const host = (import.meta as any).env?.VITE_MEANVC_HOST || "130.237.3.103";
  return `wss://${host}:5002/api/meanvc/stream?target_id=${targetId}&steps=${steps}&source_sr=${sourceSr}`;
}

export function getMeanvcLoadTargetUrl(): string {
  const host = (import.meta as any).env?.VITE_MEANVC_HOST || "130.237.3.103";
  return `https://${host}:5002/api/meanvc/load-target`;
}

const DEFAULT_PROMPT = "You enjoy having a good conversation.";

export function getPersonaplexWsURL(textPrompt?: string): string {
  const wsHost = (import.meta as any).env?.VITE_PERSONAPLEX_HOST || window.location.hostname;
  const voicePrompt = "NATF2.pt";
  const tp = textPrompt || DEFAULT_PROMPT;
  return `wss://${wsHost}:8000/api/chat?voice_prompt=${encodeURIComponent(voicePrompt)}&text_prompt=${encodeURIComponent(tp)}`;
}