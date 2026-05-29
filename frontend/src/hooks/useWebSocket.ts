import { useState, useRef, useCallback, useEffect } from "react";
import { getPersonaplexWsURL, API_BASE } from "@/lib/config";
import { createWavFile } from "@/lib/audio";

export interface Transcript {
  text: string;
  timestamp: number;
  speaker: "user" | "personaplex";
}

declare global {
  interface Window {
    "ogg-opus-decoder": {
      OggOpusDecoder: new () => OggOpusDecoder;
    };
  }
}

interface OggOpusDecoder {
  readonly ready: Promise<void>;
  decode(packet: Uint8Array): Promise<{
    channelData: Float32Array[];
    samplesDecoded: number;
    sampleRate: number;
  }>;
  free(): void;
}

export async function transcribeRecording(chunks: Blob[]): Promise<{ text: string; segments: { start: number; end: number; text: string }[] }> {
  const blob = new Blob(chunks, { type: "audio/webm" });
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = new AudioContext();
  const audioBuffer = await ctx.decodeAudioData(arrayBuffer);
  ctx.close();

  const wavBlob = createWavFile(audioBuffer.getChannelData(0), audioBuffer.sampleRate);
  const formData = new FormData();
  formData.append("audio", wavBlob, "recording.wav");

  const resp = await fetch(`${API_BASE}/api/transcribe`, {
    method: "POST",
    body: formData,
  });

  if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
  return await resp.json();
}

export function useWebSocket() {
  const socketRef = useRef<WebSocket | null>(null);
  const intentionalClose = useRef(false);
  const decoderRef = useRef<OggOpusDecoder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const scheduledEnd = useRef(0);
  const personaplexPcm = useRef<Float32Array[]>([]);
  const conversationStart = useRef(0);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [partialTranscript, setPartialTranscript] = useState("");
  const [responseChunks, setResponseChunks] = useState<ArrayBuffer[]>([]);
  const [warmupComplete, setWarmupComplete] = useState(false);
  const [handshakeReceived, setHandshakeReceived] = useState(false);

  useEffect(() => {
    const init = async () => {
      const OggDecoder = window["ogg-opus-decoder"]?.OggOpusDecoder;
      if (OggDecoder) {
        const decoder = new OggDecoder();
        await decoder.ready;
        decoderRef.current = decoder;
        console.log("Opus decoder ready");
      }
      audioCtxRef.current = new (window.AudioContext ||
        (window as any).webkitAudioContext)({ sampleRate: 48000 });
    };
    init();
    return () => {
      decoderRef.current?.free();
      audioCtxRef.current?.close();
    };
  }, []);

  const playAudio = useCallback((payload: ArrayBuffer) => {
    const decoder = decoderRef.current;
    const ctx = audioCtxRef.current;
    if (!decoder || !ctx) return;

    decoder.decode(new Uint8Array(payload)).then(({ channelData, samplesDecoded }) => {
      if (samplesDecoded === 0) return;
      personaplexPcm.current = [...personaplexPcm.current, new Float32Array(channelData[0])];
      const buffer = ctx.createBuffer(1, samplesDecoded, ctx.sampleRate);
      buffer.copyToChannel(channelData[0], 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      const now = ctx.currentTime;
      const start = Math.max(scheduledEnd.current, now);
      src.start(start);
      scheduledEnd.current = start + buffer.duration;
    }).catch(() => {});
  }, []);

  const connect = useCallback(() => {
    const url = getPersonaplexWsURL();
    console.log("Connecting to:", url);
    setError(null);
    intentionalClose.current = false;

    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    socketRef.current = socket;

    socket.onopen = () => {
      console.log("WebSocket connected, waiting for handshake...");
      setConnected(true);
    };

    socket.onerror = () => {
      setError("Connection failed. Check if the server is running.");
    };

    socket.onclose = (event) => {
      setConnected(false);
      if (!intentionalClose.current) {
        if (event.code === 1006) {
          setError("Server disconnected unexpectedly. The model may be overloaded.");
        } else if (event.code !== 1000 && event.code !== 1005) {
          setError(`Connection closed (code ${event.code}). ${event.reason || ""}`.trim());
        }
      }
    personaplexPcm.current = [];
    conversationStart.current = Date.now();
    intentionalClose.current = false;
    };

    socket.onmessage = async (event) => {
      try {
        const arrayBuffer = await (event.data instanceof Blob
          ? event.data.arrayBuffer()
          : event.data);
        const view = new Uint8Array(arrayBuffer);
        const tag = view[0];
        const payload = arrayBuffer.slice(1);

        if (tag === 0) {
          console.log("Handshake received, server ready");
          setWarmupComplete(true);
          setHandshakeReceived(true);
        } else if (tag === 1) {
          playAudio(payload);
        } else if (tag === 2) {
          const decoder = new TextDecoder();
          const text = decoder.decode(payload);
          setPartialTranscript((prev) => {
            const updated = prev + text;
            if (updated.endsWith(".") || updated.endsWith("!") || updated.endsWith("?")) {
              setTranscripts((t) => [...t, { text: updated, timestamp: Date.now(), speaker: "personaplex" }]);
              return "";
            }
            return updated;
          });
        }
      } catch {
        // Ignore unrecognized messages
      }
    };
  }, [playAudio]);

  const sendAudio = useCallback((data: ArrayBuffer) => {
    if (socketRef.current?.readyState === WebSocket.OPEN) {
      const tagged = new Uint8Array(data.byteLength + 1);
      tagged[0] = 1;
      tagged.set(new Uint8Array(data), 1);
      socketRef.current.send(tagged.buffer);
    }
  }, []);

  const disconnect = useCallback(() => {
    intentionalClose.current = true;
    socketRef.current?.close();
    socketRef.current = null;
    setConnected(false);
    setWarmupComplete(false);
    setHandshakeReceived(false);
    scheduledEnd.current = 0;
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

  const getPersonaplexWav = useCallback((): Blob | null => {
    const chunks = personaplexPcm.current;
    if (chunks.length === 0) return null;
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const combined = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
      combined.set(c, offset);
      offset += c.length;
    }
    return createWavFile(combined, 48000);
  }, []);

  const getConversationDuration = useCallback((): number => {
    const chunks = personaplexPcm.current;
    if (chunks.length === 0) return 0;
    const totalSamples = chunks.reduce((s, c) => s + c.length, 0);
    return totalSamples / 48000;
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  const addUserTranscript = useCallback((text: string) => {
    if (!text) return;
    setTranscripts((prev) => [...prev, { text, timestamp: Date.now(), speaker: "user" }]);
  }, []);

  return {
    connected,
    error,
    transcripts,
    partialTranscript,
    responseChunks,
    warmupComplete,
    handshakeReceived,
    connect,
    disconnect,
    sendAudio,
    clearTranscripts,
    clearResponseChunks,
    clearError,
    addUserTranscript,
    getPersonaplexWav,
    getConversationDuration,
  };
}