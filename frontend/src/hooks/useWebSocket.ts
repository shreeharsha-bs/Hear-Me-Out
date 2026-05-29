import { useState, useRef, useCallback, useEffect } from "react";
import { getPersonaplexWsURL } from "@/lib/config";

export interface Transcript {
  text: string;
  timestamp: number;
}

export function useWebSocket() {
  const socketRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [responseChunks, setResponseChunks] = useState<ArrayBuffer[]>([]);
  const [warmupComplete, setWarmupComplete] = useState(false);

  const connect = useCallback(() => {
    const url = getPersonaplexWsURL();
    console.log("Connecting to:", url);
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.onopen = () => setConnected(true);
    socket.onclose = () => setConnected(false);

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "warmup") {
          setWarmupComplete(true);
        } else if (data.type === "turn_complete") {
          setPartialTranscript("");
        } else if (data.text) {
          setPartialTranscript(data.text);
          if (data.is_complete) {
            setTranscripts((prev) => [...prev, { text: data.text, timestamp: Date.now() }]);
            setPartialTranscript("");
          }
        }
      } catch {
        if (event.data instanceof ArrayBuffer && event.data.byteLength > 0) {
          setResponseChunks((prev) => [...prev, event.data]);
        }
      }
    };
  }, []);

  const sendAudio = useCallback((data: ArrayBuffer) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      const tagged = new Uint8Array(data.byteLength + 1);
      tagged[0] = 1;
      tagged.set(new Uint8Array(data), 1);
      socketRef.current.send(tagged.buffer);
    }
  }, []);

  const disconnect = useCallback(() => {
    socketRef.current?.close();
    socketRef.current = null;
    setConnected(false);
  }, []);

  useEffect(() => {
    return () => disconnect();
  }, [disconnect]);

  const clearTranscripts = useCallback(() => {
    setTranscripts([]);
    setPartialTranscript("");
  }, []);

  const clearResponseChunks = useCallback(() => {
    setResponseChunks([]);
  }, []);

  return {
    connected,
    transcripts,
    partialTranscript,
    responseChunks,
    warmupComplete,
    connect,
    disconnect,
    sendAudio,
    clearTranscripts,
    clearResponseChunks,
  };
}
