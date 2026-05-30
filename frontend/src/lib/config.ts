export const API_BASE = "";
export const PERSONAPLEX_HOST = window.location.host;
export const MEANVC_HOST = window.location.hostname;

export function getPersonaplexWsURL(): string {
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const voicePrompt = "NATF2.pt";
  const textPrompt = "You enjoy having a good conversation.";
  return `${wsProtocol}//${window.location.hostname}:8000/api/chat?voice_prompt=${encodeURIComponent(voicePrompt)}&text_prompt=${encodeURIComponent(textPrompt)}`;
}