export const API_BASE = "http://130.237.3.103:5001";
export const PERSONAPLEX_HOST = "130.237.3.103";
export const MEANVC_HOST = "130.237.3.103";

export function getPersonaplexWsURL(): string {
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const voicePrompt = "NATF2.pt";
  const textPrompt = "You enjoy having a good conversation.";
  return `${wsProtocol}//${PERSONAPLEX_HOST}:8000/api/chat?voice_prompt=${encodeURIComponent(voicePrompt)}&text_prompt=${encodeURIComponent(textPrompt)}`;
}
