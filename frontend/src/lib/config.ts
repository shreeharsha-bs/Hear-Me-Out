export const API_BASE = "";
export const PERSONAPLEX_HOST = window.location.host;
export const MEANVC_HOST = (import.meta as any).env?.VITE_MEANVC_HOST || "130.237.3.103";

export function getPersonaplexWsURL(): string {
  const wsHost = (import.meta as any).env?.VITE_PERSONAPLEX_HOST || window.location.hostname;
  const voicePrompt = "NATF2.pt";
  const textPrompt = "You enjoy having a good conversation.";
  return `wss://${wsHost}:8000/api/chat?voice_prompt=${encodeURIComponent(voicePrompt)}&text_prompt=${encodeURIComponent(textPrompt)}`;
}