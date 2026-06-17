import { useRef, useCallback, useState } from "react";

export function useSpeechRecognition() {
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const [userText, setUserText] = useState("");
  const [isListening, setIsListening] = useState(false);

  const start = useCallback((onFinal: (text: string) => void) => {
    const SR = SpeechRecognition || webkitSpeechRecognition;
    if (!SR) return;

    const recognition = new SR();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognitionRef.current = recognition;

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          onFinal(result[0].transcript);
        } else {
          interim += result[0].transcript;
        }
      }
      setUserText(interim);
    };

    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      console.warn("Speech recognition unavailable, using server-only transcription");
    };

    recognition.start();
    setIsListening(true);
  }, []);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setIsListening(false);
    setUserText("");
  }, []);

  return { userText, isListening, start, stop };
}