const { useRef, useEffect, useState } = React;

const apiBase = window.__API_BASE__ || '';
const PERSONAPLEX_HOST = window.__PERSONAPLEX_WS_URL__ ? null : (window.__PERSONAPLEX_HOST__ || window.location.hostname);
const MEANVC_HOST = window.__MEANVC_HOST__ || window.location.hostname;

// Helper function to generate a timestamp for the filename
const getTimestamp = () => {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, '-');
};

// Helper function to convert PCM audio data to WAV format
const createWavFile = (audioData, sampleRate) => {
  const numChannels = 1;
  const bitsPerSample = 16; // 16-bit PCM
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = audioData.length * bytesPerSample;
  const bufferSize = 44 + dataSize; // 44 bytes for the WAV header, plus the audio data
  
  // Create the WAV file buffer
  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);

  // WAV header
  // "RIFF" chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true); // file size minus RIFF chunk descriptor (8 bytes)
  writeString(view, 8, 'WAVE');

  // "fmt " sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM format = 16 bytes
  view.setUint16(20, 1, true); // PCM format = 1
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // "data" sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write the PCM samples
  let offset = 44;
  for (let i = 0; i < audioData.length; i++) {
    // Convert float32 samples (-1.0 to 1.0) to int16 (-32768 to 32767)
    const sample = Math.max(-1, Math.min(1, audioData[i]));
    const value = sample < 0 ? sample * 32768 : sample * 32767;
    view.setInt16(offset, value, true);
    offset += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
};

// Helper function to write a string to a DataView
const writeString = (view, offset, string) => {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
};

const getPersonaplexWsURL = () => {
  if (window.__PERSONAPLEX_WS_URL__) {
    return window.__PERSONAPLEX_WS_URL__;
  }
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let hostname = window.__PERSONAPLEX_HOST__ || window.location.hostname;
  if (hostname === '0.0.0.0' || hostname === '127.0.0.1') {
    hostname = 'localhost';
  }
  const voicePrompt = window.__VOICE_PROMPT__ || 'NATF2.pt';
  const textPrompt = window.__TEXT_PROMPT__ || 'You enjoy having a good conversation.';
  return `${wsProtocol}//${hostname}:8000/api/chat?voice_prompt=${encodeURIComponent(voicePrompt)}&text_prompt=${encodeURIComponent(textPrompt)}`;
}

const App = () => {
  // View toggle: /?view=meanvc shows MeanVC test, default is conversation
  const params = new URLSearchParams(window.location.search);
  const [currentView, setCurrentView] = useState(
    params.get('view') === 'meanvc' ? 'meanvc' : 'conversation'
  );
  const switchView = (view) => {
    setCurrentView(view);
    window.history.replaceState({}, '', view === 'meanvc' ? '/?view=meanvc' : '/');
  };

  // Mic Input
  const [recorder, setRecorder] = useState(null); // Opus recorder
  const [amplitude, setAmplitude] = useState(0); // Amplitude, captured from PCM analyzer
  
  // Audio recording for WAV file
  const [recordedChunks, setRecordedChunks] = useState([]); // Store the audio chunks for WAV recording
  const recordingStreamRef = useRef(null); // Store the media stream for WAV recording
  const mediaRecorderRef = useRef(null); // MediaRecorder for WAV recording
  const [recordingAvailable, setRecordingAvailable] = useState(false); // Flag to indicate if a recording is available to save
  
  // Store model responses
  const [modelResponseChunks, setModelResponseChunks] = useState([]); // Store the audio chunks from model responses
  const [modelResponseAvailable, setModelResponseAvailable] = useState(false); // Flag to indicate if model responses are available

  // Audio playback
  const [audioContext] = useState(() => new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 }));
  const sourceNodeRef = useRef(null); // Audio source node
  const scheduledEndTimeRef = useRef(0); // Scheduled end time for audio playback
  const decoderRef = useRef(null); // Decoder for converting opus to PCM

  // WebSocket
  const socketRef = useRef(null); // Ongoing websocket connection

  // UI State
  const [warmupComplete, setWarmupComplete] = useState(false);
  const [completedSentences, setCompletedSentences] = useState([]);
  const [pendingSentence, setPendingSentence] = useState('');
  const [isRecording, setIsRecording] = useState(false); // Recording state
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false); // Sidebar collapse state

  // Previous conversations for comparison
  const [previousConversations, setPreviousConversations] = useState([]);

  // Voice Conversion state
  const [sourceAudioFile, setSourceAudioFile] = useState(null);
  const [targetAudioFile, setTargetAudioFile] = useState(null);
  const [isConverting, setIsConverting] = useState(false);
  const [convertedAudioUrl, setConvertedAudioUrl] = useState(null);
  const [conversionError, setConversionError] = useState(null);

  // Metrics comparison state
  const [isComparingMetrics, setIsComparingMetrics] = useState(false);
  const [metricsPlotUrl, setMetricsPlotUrl] = useState(null);
  const [metricsError, setMetricsError] = useState(null);
  const [firstAIRecording, setFirstAIRecording] = useState(null); // First AI voice recording for comparison
  const [secondAIRecording, setSecondAIRecording] = useState(null); // Second AI voice recording for comparison
  const [conversationCount, setConversationCount] = useState(0); // Track number of conversations

  // MeanVC Voice Conversion Pipeline
  const [vcEnabled, setVcEnabled] = useState(false);
  const [vcTargetId, setVcTargetId] = useState(null);
  const [vcTargetFile, setVcTargetFile] = useState(null);
  const [vcStatus, setVcStatus] = useState('');
  const meanvcWsRef = useRef(null);
  const pcmStreamRef = useRef(null);
  const pcmContextRef = useRef(null);

  const uploadVcTarget = async (file) => {
    if (!file) return;
    setVcTargetFile(file.name);
    setVcStatus('Loading target voice...');
    const fd = new FormData();
    fd.append('wav', file);
    try {
      const resp = await fetch(`https://${MEANVC_HOST}:5002/api/meanvc/load-target`, {
        method: 'POST', body: fd,
      });
      const data = await resp.json();
      if (data.target_id) {
        setVcTargetId(data.target_id);
        setVcStatus(`Target ready: ${file.name} (${data.duration_seconds}s)`);
      } else {
        setVcStatus('Error: ' + (data.error || 'unknown'));
      }
    } catch (e) {
      setVcStatus('Error: ' + e.message);
    }
  };

  // MeanVC Voice Conversion Pipeline: Mic → MeanVC → PersonaPlex
  const startVCStreamingPipeline = async () => {
    setVcStatus('Starting voice conversion pipeline...');

    // 1. Get raw mic
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    });
    pcmStreamRef.current = stream;
    recordingStreamRef.current = stream;

    // 2. AudioContext for PCM capture + VC output playback
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    pcmContextRef.current = audioCtx;

    // 3. ScriptProcessor to capture mic PCM
    const source = audioCtx.createMediaStreamSource(stream);
    const processor = audioCtx.createScriptProcessor(2048, 1, 1);

    // 4. MediaStreamDestination for VC output → OpusRecorder
    const vcDest = audioCtx.createMediaStreamDestination();

    // 5. Connect to MeanVC WS
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const meanvcUrl = `${wsProtocol}//${MEANVC_HOST}:5002/api/meanvc/stream?target_id=${vcTargetId}&steps=8&source_sr=${audioCtx.sampleRate}`;
    const meanvcWs = new WebSocket(meanvcUrl);
    meanvcWsRef.current = meanvcWs;

    let vcOutputTime = audioCtx.currentTime + 0.5;

    meanvcWs.onmessage = async (event) => {
      if (typeof event.data === 'string') return;
      // Got converted PCM from MeanVC → write to virtual stream
      const float32 = new Float32Array(await event.data.arrayBuffer());
      if (float32.length === 0) return;
      const buf = audioCtx.createBuffer(1, float32.length, 16000);
      buf.getChannelData(0).set(float32);
      const bufSource = audioCtx.createBufferSource();
      bufSource.buffer = buf;
      bufSource.connect(vcDest);
      bufSource.start(vcOutputTime);
      vcOutputTime = Math.max(vcOutputTime + buf.duration, audioCtx.currentTime + 0.01);
    };

    // 6. OpusRecorder captures from VC output stream → PersonaPlex WS
    const vcRecorder = new Recorder({
      encoderPath: "https://cdn.jsdelivr.net/npm/opus-recorder@latest/dist/encoderWorker.min.js",
      streamPages: true,
      encoderApplication: 2049,
      encoderFrameSize: 40,
      encoderSampleRate: 16000,
      maxFramesPerPage: 1,
      numberOfChannels: 1,
    });

    vcRecorder.ondataavailable = async (arrayBuffer) => {
      if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
        const tagged = new Uint8Array(arrayBuffer.byteLength + 1);
        tagged[0] = 1;
        tagged.set(new Uint8Array(arrayBuffer), 1);
        await socketRef.current.send(tagged.buffer);
      }
    };

    meanvcWs.onopen = () => {
      setVcStatus('Connected - streaming voice conversion');
      // Start OpusRecorder on VC output
      vcRecorder.start(vcDest.stream).then(() => {
        // Start sending mic PCM to MeanVC
        processor.onaudioprocess = (e) => {
          if (meanvcWs.readyState === WebSocket.OPEN) {
            meanvcWs.send(e.inputBuffer.getChannelData(0).buffer);
          }
        };
        source.connect(processor);
        processor.connect(audioCtx.destination); // silence
      });
    };

    meanvcWs.onclose = () => setVcStatus('MeanVC disconnected');
    meanvcWs.onerror = () => setVcStatus('MeanVC WebSocket error');

    // Set recorder for amplitude/mute control
    setRecorder(vcRecorder);
    setIsRecording(true);

    // Amplitude analyzer
    const analyzerCtx = new (window.AudioContext || window.webkitAudioContext)();
    const analyzer = analyzerCtx.createAnalyser();
    analyzer.fftSize = 256;
    analyzerCtx.createMediaStreamSource(stream).connect(analyzer);
    const processAudio = () => {
      const dataArray = new Uint8Array(analyzer.frequencyBinCount);
      analyzer.getByteFrequencyData(dataArray);
      setAmplitude(dataArray.reduce((a, b) => a + b, 0) / dataArray.length);
      requestAnimationFrame(processAudio);
    };
    processAudio();
  };

  // Mic Input: start the Opus recorder
  const startRecording = async () => {
    if (vcEnabled && vcTargetId) {
      await startVCStreamingPipeline();
      return;
    }
    // Original OpusRecorder flow (no VC)
    // Reset recorded chunks and model responses for new recording
    setRecordedChunks([]);
    setRecordingAvailable(false);
    setModelResponseChunks([]);
    setModelResponseAvailable(false);
    
    // prompts user for permission to use microphone
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordingStreamRef.current = stream;

    const recorder = new Recorder({
      encoderPath: "https://cdn.jsdelivr.net/npm/opus-recorder@latest/dist/encoderWorker.min.js",
      streamPages: true,
      encoderApplication: 2049,
      encoderFrameSize: 80, // milliseconds, equal to 1920 samples at 24000 Hz
      encoderSampleRate: 24000,  // 24000 to match model's sample rate
      maxFramesPerPage: 1,
      numberOfChannels: 1,
    });

    recorder.ondataavailable = async (arrayBuffer) => {
      if (socketRef.current) {
        if (socketRef.current.readyState !== WebSocket.OPEN) {
          console.log("Socket not open, dropping audio");
          return;
        }
        const tagged = new Uint8Array(arrayBuffer.byteLength + 1);
        tagged[0] = 1;
        tagged.set(new Uint8Array(arrayBuffer), 1);
        await socketRef.current.send(tagged.buffer);
      }
    };

    recorder.start().then(() => {
      console.log("Recording started");
      setRecorder(recorder);
      setIsRecording(true); // Set recording state to true
    });

    // create a MediaRecorder object for capturing PCM (calculating amplitude)
    const analyzerContext = new (window.AudioContext || window.webkitAudioContext)();
    const analyzer = analyzerContext.createAnalyser();
    analyzer.fftSize = 256;
    const sourceNode = analyzerContext.createMediaStreamSource(stream);
    sourceNode.connect(analyzer);

    // Use a separate audio processing function instead of MediaRecorder
    const processAudio = () => {
      const dataArray = new Uint8Array(analyzer.frequencyBinCount);
      analyzer.getByteFrequencyData(dataArray);
      const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
      setAmplitude(average);
      requestAnimationFrame(processAudio);
    };
    processAudio();

    // Setup WAV recording using MediaRecorder
    // Note: We still collect as WebM but convert to WAV on save
    const mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    mediaRecorderRef.current = mediaRecorder;

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        setRecordedChunks(prevChunks => [...prevChunks, event.data]);
      }
    };

    mediaRecorder.onstop = () => {
      console.log("WAV recording stopped");
      setRecordingAvailable(true);
    };

    // Start capturing audio for WAV file
    mediaRecorder.start();
    console.log("WAV recording started");
  };

  // Stop recording and websocket connection
  const stopRecording = () => {
    // Clean up MeanVC pipeline
    if (meanvcWsRef.current) {
      meanvcWsRef.current.close();
      meanvcWsRef.current = null;
    }
    if (pcmContextRef.current) {
      pcmContextRef.current.close();
      pcmContextRef.current = null;
    }
    if (pcmStreamRef.current) {
      pcmStreamRef.current.getTracks().forEach(t => t.stop());
      pcmStreamRef.current = null;
    }

    if (recorder) {
      recorder.stop();
      setIsRecording(false);
      console.log("Opus recording stopped");
    }
    
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      console.log("WAV recording stopped");
    }
    
    if (recordingStreamRef.current) {
      recordingStreamRef.current.getTracks().forEach(track => track.stop());
      recordingStreamRef.current = null;
    }
    
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
    
    // Finalize model response recording when stopping
    setModelResponseAvailable(modelResponseChunks.length > 0);
  };
  
  // Clean up resources when component unmounts
  useEffect(() => {
    return () => {
      stopRecording();
    };
  }, []);

  // Load default target audio file for voice conversion
  useEffect(() => {
    const loadDefaultTargetFile = async () => {
      try {
        // Use the local server endpoint to load the default target file
        const fileName = 'tara__chuckle_Hey_I_know_this_is_a_bit_of_a_weird_request_but_laugh_I_really_need_to_get_into_the_server_room_Can_you_let_me_in_.wav';
        const defaultTargetPath = `recordings/${fileName}`;
        const response = await fetch(`${apiBase}/${defaultTargetPath}`);
        
        if (response.ok) {
          const blob = await response.blob();
          // Create a File object from the blob with the original filename
          const file = new File([blob], fileName, { type: blob.type || 'audio/wav' });
          setTargetAudioFile(file);
          console.log('Default target audio file loaded:', fileName);
        } else {
          console.warn('Could not load default target audio file - file not found or not accessible');
        }
      } catch (error) {
        console.error('Error loading default target audio file:', error);
        // Don't show error to user, just log it as it's optional functionality
      }
    };

    loadDefaultTargetFile();
  }, []);

  // Function to save the user's voice recording to a WAV file
  const saveRecording = async () => {
    if (recordedChunks.length === 0) {
      console.log("No user recording available to save");
      return;
    }

    try {
      // Convert WebM blob to audio data
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const blob = new Blob(recordedChunks, { type: 'audio/webm' });
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      
      // Get PCM data from the audio buffer
      const channelData = audioBuffer.getChannelData(0);
      const sampleRate = audioBuffer.sampleRate;
      
      // Create a WAV file
      const wavBlob = createWavFile(channelData, sampleRate);
      
      // Create a File object and set it as the source for voice conversion
      const fileName = `hear-me-out-user-voice-${getTimestamp()}.wav`;
      const file = new File([wavBlob], fileName, { type: 'audio/wav' });
      setSourceAudioFile(file);
      console.log('User recording set as source for voice conversion.');

      // Download the WAV file
      const url = URL.createObjectURL(wavBlob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      
      // Clean up
      setTimeout(() => {
        URL.revokeObjectURL(url);
        document.body.removeChild(a);
      }, 100);
    } catch (err) {
      console.error("Error converting user recording to WAV:", err);
    }
  };

  // Function to save the AI's voice responses to a WAV file
  const saveModelResponses = () => {
    if (modelResponseChunks.length === 0) {
      console.log("No AI voice responses available to save");
      return;
    }
    
    // Process all chunks to create a single WAV file
    const processChunks = () => {
      // Get the sample rate (use the first chunk's sample rate)
      const sampleRate = modelResponseChunks[0].sampleRate || 48000;
      
      // Calculate total length of all audio data
      const totalLength = modelResponseChunks.reduce((total, chunk) => total + chunk.data.length, 0);
      const concatenatedData = new Float32Array(totalLength);
      
      // Concatenate all audio data into a single Float32Array
      let offset = 0;
      for (const chunk of modelResponseChunks) {
        concatenatedData.set(chunk.data, offset);
        offset += chunk.data.length;
      }
      
      // Create a single WAV file from the concatenated data
      if (concatenatedData.length > 0) {
        const wavBlob = createWavFile(concatenatedData, sampleRate);
        
        // Save for metrics comparison
        const fileName = `ai-voice-conversation-${conversationCount + 1}-${getTimestamp()}.wav`;
        const file = new File([wavBlob], fileName, { type: 'audio/wav' });
        
        // Store the recording for metrics comparison
        if (!firstAIRecording) {
          setFirstAIRecording(file);
          console.log('First AI recording saved for metrics comparison');
        } else if (!secondAIRecording) {
          setSecondAIRecording(file);
          console.log('Second AI recording saved for metrics comparison');
        } else {
          // If both slots are filled, move second to first and save new as second
          setFirstAIRecording(secondAIRecording);
          setSecondAIRecording(file);
          console.log('Updated AI recordings for metrics comparison');
        }
        
        // Download the WAV file
        const url = URL.createObjectURL(wavBlob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        
        // Clean up
        setTimeout(() => {
          URL.revokeObjectURL(url);
          document.body.removeChild(a);
        }, 100);
      } else {
        console.error("Failed to create WAV file from AI responses");
      }
    };
    
    try {
      processChunks();
    } catch (err) {
      console.error("Error saving AI responses:", err);
    }
  };
  
  // Function to save the full conversation (both user and AI voices) - Removed as requested
  
  // Audio Playback: Prep decoder for converting opus to PCM for audio playback
  useEffect(() => {
    const initializeDecoder = async () => {
      const decoder = new window["ogg-opus-decoder"].OggOpusDecoder();
      await decoder.ready;
      decoderRef.current = decoder;
      console.log("Ogg Opus decoder initialized");
    };
  
    initializeDecoder();
  
    return () => {
      if (decoderRef.current) {
        decoderRef.current.free();
      }
    };
  }, []);

  // Audio Playback: schedule PCM audio chunks for seamless playback
  const scheduleAudioPlayback = (newAudioData) => {
    const sampleRate = audioContext.sampleRate;
    const numberOfChannels = 1;
    const nowTime = audioContext.currentTime;
  
    // Create a new buffer and source node for the incoming audio data
    const newBuffer = audioContext.createBuffer(numberOfChannels, newAudioData.length, sampleRate);
    newBuffer.copyToChannel(newAudioData, 0);
    const sourceNode = audioContext.createBufferSource();
    sourceNode.buffer = newBuffer;
    sourceNode.connect(audioContext.destination);
  
    // Schedule the new audio to play immediately after any currently playing audio
    const startTime = Math.max(scheduledEndTimeRef.current, nowTime);
    sourceNode.start(startTime);
  
    // Update the scheduled end time so we know when to schedule the next piece of audio
    scheduledEndTimeRef.current = startTime + newBuffer.duration;
  
    if (sourceNodeRef.current && sourceNodeRef.current.buffer) {
      const currentEndTime = sourceNodeRef.current.startTime + sourceNodeRef.current.buffer.duration;
      if (currentEndTime <= nowTime) {
        sourceNodeRef.current.disconnect();
      }
    }
    sourceNodeRef.current = sourceNode;
  };

  // WebSocket: open websocket connection and start recording
  const startWebSocket = () => {
    // Save current conversation if it has content and this isn't the first conversation
    if (completedSentences.length > 0 || pendingSentence.trim() !== '') {
      const currentConversation = {
        id: Date.now(),
        completedSentences: [...completedSentences],
        pendingSentence: pendingSentence,
        warmupComplete: warmupComplete
      };
      setPreviousConversations(prev => [...prev, currentConversation]);
      
      // Reset current conversation state
      setCompletedSentences([]);
      setPendingSentence('');
      setWarmupComplete(false);
    }

    // Increment conversation count
    setConversationCount(prev => prev + 1);

    const endpoint = getPersonaplexWsURL();
    console.log("Connecting to", endpoint);
    const socket = new WebSocket(endpoint);
    socketRef.current = socket;

    socket.onopen = () => {
      console.log("WebSocket connection opened, waiting for PersonaPlex handshake...");
    };

    socket.onmessage = async (event) => {
      // data is a blob, convert to array buffer
      const arrayBuffer = await event.data.arrayBuffer();
      const view = new Uint8Array(arrayBuffer);
      const tag = view[0];
      const payload = arrayBuffer.slice(1);
      if (tag === 0) {
        // PersonaPlex handshake - server is ready, start sending audio
        console.log("Received PersonaPlex handshake, starting recording");
        startRecording();
        setWarmupComplete(true);
        return;
      }
      if (tag === 1) {
        // audio data
        const { channelData, samplesDecoded, sampleRate } = await decoderRef.current.decode(new Uint8Array(payload));
        if (samplesDecoded > 0) {
          // Store raw audio data with its sample rate for later use
          const audioData = {
            data: channelData[0],
            sampleRate: sampleRate
          };
          
          // Store the audio data object instead of a WAV blob
          setModelResponseChunks(prevChunks => [...prevChunks, audioData]);
          setModelResponseAvailable(true);
          
          // Play the audio
          scheduleAudioPlayback(channelData[0]);
        }
      }
      if (tag === 2) {
        // text data
        const decoder = new TextDecoder();
        const text = decoder.decode(payload);

        setPendingSentence(prevPending => {
          const updatedPending = prevPending + text;
          if (updatedPending.endsWith('.') || updatedPending.endsWith('!') || updatedPending.endsWith('?')) {
            setCompletedSentences(prevCompleted => [...prevCompleted, updatedPending]);
            return '';
          }
          return updatedPending;
        });
      }
    };

    socket.onclose = () => {
      console.log("WebSocket connection closed");
    };

    return () => {
      socket.close();
    };
  };

  // Voice conversion function
  const runVoiceConversion = async () => {
    if (!sourceAudioFile || !targetAudioFile) {
      setConversionError("Please select both source and target audio files");
      return;
    }

    setIsConverting(true);
    setConversionError(null);
    setConvertedAudioUrl(null);

    try {
      const formData = new FormData();
      formData.append('source_audio', sourceAudioFile);
      formData.append('target_audio', targetAudioFile);
      
      // Optional parameters
      formData.append('diffusion_steps', '30');
      formData.append('length_adjust', '1.0');
      formData.append('inference_cfg_rate', '0.7');

const response = await fetch(apiBase + '/api/voice-conversion', {
          method: 'POST',
          body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Voice conversion failed');
      }

      // Create a blob URL for the converted audio
      const audioBlob = await response.blob();
      const audioUrl = URL.createObjectURL(audioBlob);
      setConvertedAudioUrl(audioUrl);
      
      console.log("Voice conversion completed successfully");
    } catch (error) {
      console.error("Voice conversion error:", error);
      setConversionError(error.message);
    } finally {
      setIsConverting(false);
    }
  };

  // Metrics comparison function
  const runMetricsComparison = async () => {
    if (!firstAIRecording || !secondAIRecording) {
      setMetricsError("Please record AI voices from two different conversations first");
      return;
    }

    setIsComparingMetrics(true);
    setMetricsError(null);
    setMetricsPlotUrl(null);

    try {
      const formData = new FormData();
      formData.append('source_audio', firstAIRecording);
      formData.append('target_audio', secondAIRecording);

const response = await fetch(apiBase + '/api/metrics-comparison', {
          method: 'POST',
          body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Metrics comparison failed');
      }

      // Create a blob URL for the plot image
      const plotBlob = await response.blob();
      const plotUrl = URL.createObjectURL(plotBlob);
      setMetricsPlotUrl(plotUrl);
      
      console.log("Metrics comparison completed successfully");
    } catch (error) {
      console.error("Metrics comparison error:", error);
      setMetricsError(error.message);
    } finally {
      setIsComparingMetrics(false);
    }
  };

  return (
    <div className="bg-gray-900 text-white min-h-screen flex flex-col">
      <header className="w-full flex items-center p-4 bg-gray-800 fixed top-0 left-0 z-10">
        <img src="./KTH_Logo.jpg" alt="KTH Logo" className="h-20 mr-4" />
        <div className="flex-1">
          <h1 className="text-3xl font-bold">Hear Me Out</h1>
          <h2 className="text-xl">Interactive evaluation and bias discovery platform for
          speech-to-speech conversational AI</h2>
          <h3 className="text-lg">KTH Royal Institute of Technology, Stockholm, Sweden</h3>
        </div>
        <button
          onClick={() => switchView(currentView === 'conversation' ? 'meanvc' : 'conversation')}
          className={`px-4 py-2 rounded-lg font-semibold text-sm transition-colors ${
            currentView === 'meanvc' ? 'bg-gray-600 hover:bg-gray-500' : 'bg-green-600 hover:bg-green-500'
          }`}
        >
          {currentView === 'conversation' ? 'Voice Conversion Test' : 'PersonaPlex Chat'}
        </button>
      </header>

      {currentView === 'meanvc' ? (
        <MeanVCTest />
      ) : (
      <>
      <div className="flex h-screen pt-32">
        {/* Collapsible Sidebar */}
        <div className={`${isSidebarCollapsed ? 'w-12' : 'w-80'} bg-gray-800 fixed left-0 top-32 bottom-0 transition-all duration-300 shadow-lg flex flex-col h-auto z-10`}>
          {isSidebarCollapsed ? (
            <button 
              onClick={() => setIsSidebarCollapsed(false)}
              className="p-3 bg-gray-700 hover:bg-gray-600 transition-colors"
              title="Expand Sidebar"
            >
              <span className="text-xl">→</span>
            </button>
          ) : (
            <>
              <div className="flex justify-between items-center p-3 bg-gray-700">
                <span className="font-bold text-blue-400">Conversation Starters</span>
                <button 
                  onClick={() => setIsSidebarCollapsed(true)}
                  className="p-1 hover:bg-gray-600 rounded"
                  title="Collapse Sidebar"
                >
                  <span className="text-xl">←</span>
                </button>
              </div>
              <div className="p-4 overflow-y-auto flex-1">
                <SuggestionSidebar />
              </div>
            </>
          )}
        </div>
        
        {/* Main content - flexible layout for side-by-side conversations */}
        <div className={`flex-1 flex justify-start items-start transition-all duration-300 ${isSidebarCollapsed ? 'ml-12' : 'ml-80'} overflow-x-auto`}>
          <div className="flex gap-4 px-4 py-6 min-w-max">
            {/* Current conversation - always shown */}
            <div className="min-w-[32rem] max-w-2xl">
              <div className="bg-gray-800 rounded-lg shadow-lg w-full p-6 flex flex-col items-center">
                <div className="flex w-full mb-2">
                  <h3 className="text-lg font-semibold text-blue-400">
                    {previousConversations.length > 0 ? 'Current Conversation' : 'Conversation'}
                  </h3>
                </div>
                <div className="flex w-full">
                  <div className="w-5/6 overflow-y-auto max-h-64">
                    <TextOutput warmupComplete={warmupComplete} completedSentences={completedSentences} pendingSentence={pendingSentence} />
                  </div>
                  <div className="w-1/6 ml-4 pl-4">
                    <AudioControl recorder={recorder} amplitude={amplitude} />
                  </div>
                </div>
                
                {/* PersonaPlex Prompt Controls */}
                <div className="mt-6 p-4 bg-gray-700 rounded-lg w-full">
                  <h3 className="text-sm font-semibold text-blue-400 mb-3">Persona Settings</h3>
                  <div className="grid grid-cols-1 gap-3">
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Voice Prompt</label>
                      <select
                        className="w-full bg-gray-600 text-white text-sm rounded px-3 py-2"
                        defaultValue={window.__VOICE_PROMPT__ || 'NATF2.pt'}
                        onChange={(e) => { window.__VOICE_PROMPT__ = e.target.value; }}
                      >
                        <option value="NATF0.pt">NATF0 - Natural Female 0</option>
                        <option value="NATF1.pt">NATF1 - Natural Female 1</option>
                        <option value="NATF2.pt">NATF2 - Natural Female 2</option>
                        <option value="NATF3.pt">NATF3 - Natural Female 3</option>
                        <option value="NATM0.pt">NATM0 - Natural Male 0</option>
                        <option value="NATM1.pt">NATM1 - Natural Male 1</option>
                        <option value="NATM2.pt">NATM2 - Natural Male 2</option>
                        <option value="NATM3.pt">NATM3 - Natural Male 3</option>
                        <option value="VARF0.pt">VARF0 - Variety Female 0</option>
                        <option value="VARF1.pt">VARF1 - Variety Female 1</option>
                        <option value="VARM0.pt">VARM0 - Variety Male 0</option>
                        <option value="VARM1.pt">VARM1 - Variety Male 1</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs text-gray-400 mb-1">Text Prompt (Persona)</label>
                      <textarea
                        className="w-full bg-gray-600 text-white text-sm rounded px-3 py-2"
                        rows="2"
                        defaultValue={window.__TEXT_PROMPT__ || 'You enjoy having a good conversation.'}
                        onChange={(e) => { window.__TEXT_PROMPT__ = e.target.value; }}
                      />
                    </div>
                  </div>
                </div>

                {/* MeanVC Voice Conversion Pipeline */}
                <div className="mt-6 p-4 bg-gray-700 rounded-lg w-full">
                  <h3 className="text-sm font-semibold text-purple-400 mb-3">Voice Conversion Pipeline (MeanVC)</h3>
                  <p className="text-xs text-gray-400 mb-2">Route your mic through MeanVC to speak as the target voice</p>
                  <div className="flex items-center gap-3 mb-3">
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input type="checkbox" className="sr-only peer" checked={vcEnabled}
                        onChange={(e) => setVcEnabled(e.target.checked)} />
                      <div className="w-9 h-5 bg-gray-600 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-600"></div>
                      <span className="ms-3 text-xs text-gray-300">{vcEnabled ? 'Enabled' : 'Disabled'}</span>
                    </label>
                    {vcStatus && <span className={`text-xs ${vcStatus.includes('Error') ? 'text-red-400' : 'text-green-400'}`}>{vcStatus}</span>}
                  </div>
                  {vcEnabled && (
                    <div>
                      <input type="file" accept="audio/wav,.wav" onChange={(e) => uploadVcTarget(e.target.files[0])}
                        className="w-full text-xs text-gray-300 file:mr-4 file:py-1 file:px-3 file:rounded file:bg-purple-600 file:text-white file:border-0 hover:file:bg-purple-500" />
                    </div>
                  )}
                </div>

                {/* Voice Conversion Section */}
                <div className="mt-6 p-4 bg-gray-700 rounded-lg">
                  <h3 className="text-lg font-semibold text-blue-400 mb-4">Voice Conversion</h3>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                    {/* Source Audio Upload */}
                    <div className="space-y-2">
                      <label className="block text-sm font-medium text-gray-300">
                        Source Audio (voice to convert)
                      </label>
                      <input
                        type="file"
                        accept="audio/*"
                        onChange={(e) => setSourceAudioFile(e.target.files[0])}
                        className="block w-full text-sm text-gray-300 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 bg-gray-600 rounded-md"
                      />
                      {sourceAudioFile && (
                        <div className="px-3 py-1 bg-gray-600 rounded-md">
                          <p className="text-xs text-green-400 truncate" title={sourceAudioFile.name}>
                            ✓ {sourceAudioFile.name}
                          </p>
                        </div>
                      )}
                    </div>
                    
                    {/* Target Audio Upload */}
                    <div className="space-y-2">
                      <label className="block text-sm font-medium text-gray-300">
                        Target Audio (voice style reference)
                        <span className="text-xs text-blue-400 ml-2">(Default file pre-loaded)</span>
                      </label>
                      <input
                        type="file"
                        accept="audio/*"
                        onChange={(e) => setTargetAudioFile(e.target.files[0])}
                        className="block w-full text-sm text-gray-300 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 bg-gray-600 rounded-md"
                      />
                      {targetAudioFile && (
                        <div className="px-3 py-1 bg-gray-600 rounded-md">
                          <p className="text-xs text-green-400 truncate" title={targetAudioFile.name}>
                            ✓ {targetAudioFile.name}
                            {targetAudioFile.name.includes('tara__chuckle') && (
                              <span className="text-blue-400 ml-2">(auto-loaded)</span>
                            )}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  {/* Error Display */}
                  {conversionError && (
                    <div className="mb-6 p-4 bg-red-600/20 border border-red-600 text-red-300 rounded-lg text-sm">
                      <span className="font-semibold">Error:</span> {conversionError}
                    </div>
                  )}
                  
                  {/* Run Voice Conversion Button */}
                  <div className="flex justify-center mb-4">
                    <button
                      onClick={runVoiceConversion}
                      disabled={!sourceAudioFile || !targetAudioFile || isConverting}
                      className={`py-3 px-8 rounded-lg font-semibold flex items-center transition-all duration-200 ${
                        !sourceAudioFile || !targetAudioFile || isConverting
                          ? 'bg-gray-500 text-gray-300 cursor-not-allowed'
                          : 'bg-purple-600 hover:bg-purple-700 text-white shadow-lg hover:shadow-xl'
                      }`}
                    >
                      {isConverting ? (
                        <>
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                          Converting...
                        </>
                      ) : (
                        <>
                          <span className="mr-2">🎤</span>
                          Run Voice Conversion
                        </>
                      )}
                    </button>
                  </div>
                    
                  {/* Converted Audio Player */}
                  {convertedAudioUrl && (
                    <div className="mt-6 w-full">
                      <h4 className="text-sm font-medium text-green-400 mb-3">Converted Audio:</h4>
                      <audio controls className="w-full mb-3">
                        <source src={convertedAudioUrl} type="audio/wav" />
                        Your browser does not support the audio element.
                      </audio>
                      <div className="flex justify-center">
                        <a
                          href={convertedAudioUrl}
                          download="converted_voice.wav"
                          className="inline-block px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm rounded-lg transition-colors"
                        >
                          Download Converted Audio (Play in a separate music app!)
                        </a>
                      </div>
                    </div>
                  )}
                </div>
                
                {/* Original buttons section */}
                <div className="flex flex-wrap gap-2 mt-4">
                  {!isRecording ? (
                    <button
                      className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded flex items-center"
                      onClick={startWebSocket}
                    >
                      <span className="mr-1">▶️</span> Start Conversation
                    </button>
                  ) : (
                    <button
                      className="bg-red-500 hover:bg-red-700 text-white font-bold py-2 px-4 rounded flex items-center"
                      onClick={stopRecording}
                    >
                      <span className="mr-1">⏹️</span> Stop Conversation
                    </button>
                  )}
                  {recordingAvailable && (
                    <button
                      className="bg-green-500 hover:bg-green-700 text-white font-bold py-2 px-4 rounded flex items-center"
                      onClick={saveRecording}
                      title="Download a recording of your voice input only"
                    >
                      <span className="mr-1">💬</span> Save and Load Your Voice for VC
                    </button>
                  )}
                  {modelResponseAvailable && !isRecording && (
                    <button
                      className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded flex items-center"
                      onClick={saveModelResponses}
                      title="Download a recording of the AI's voice responses only"
                    >
                      <span className="mr-1">🤖</span> Save AI Voice
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* AI Voice Metrics Comparison - Complete section positioned to the right */}
            <div className="min-w-[32rem] max-w-2xl">
              <div className="bg-gray-800 rounded-lg shadow-lg w-full p-6 border-l-4 border-green-400">
                <h3 className="text-lg font-semibold text-green-400 mb-4">🎯 AI Voice Metrics Comparison</h3>
                <p className="text-sm text-gray-300 mb-4">
                  Compare AI voice characteristics between different conversations. Record AI voices from two conversations to enable comparison.
                </p>
                
                {/* AI Recording Status */}
                <div className="grid grid-cols-1 gap-4 mb-6">
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-gray-300">
                      First AI Recording
                    </label>
                    <div className={`p-3 rounded-md border-2 ${
                      firstAIRecording ? 'border-green-500 bg-green-500/10' : 'border-gray-500 bg-gray-600'
                    }`}>
                      {firstAIRecording ? (
                        <div className="flex items-center">
                          <span className="text-green-400 mr-2">✓</span>
                          <span className="text-sm text-green-400 truncate">
                            {firstAIRecording.name}
                          </span>
                        </div>
                      ) : (
                        <span className="text-sm text-gray-400">
                          Record a conversation and save AI voice
                        </span>
                      )}
                    </div>
                  </div>
                  
                  <div className="space-y-2">
                    <label className="block text-sm font-medium text-gray-300">
                      Second AI Recording
                    </label>
                    <div className={`p-3 rounded-md border-2 ${
                      secondAIRecording ? 'border-green-500 bg-green-500/10' : 'border-gray-500 bg-gray-600'
                    }`}>
                      {secondAIRecording ? (
                        <div className="flex items-center">
                          <span className="text-green-400 mr-2">✓</span>
                          <span className="text-sm text-green-400 truncate">
                            {secondAIRecording.name}
                          </span>
                        </div>
                      ) : (
                        <span className="text-sm text-gray-400">
                          Start a new conversation and save AI voice
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                
                {/* Instructions */}
                {(!firstAIRecording || !secondAIRecording) && (
                  <div className="mb-6 p-4 bg-blue-600/20 border border-blue-600 text-blue-300 rounded-lg text-sm">
                    <span className="font-semibold">How to use:</span> Have conversations with the AI and click "Save AI Voice" after each one. 
                    The system will automatically use these recordings for comparison.
                  </div>
                )}
                
                {/* Metrics Error Display */}
                {metricsError && (
                  <div className="mb-6 p-4 bg-red-600/20 border border-red-600 text-red-300 rounded-lg text-sm">
                    <span className="font-semibold">Error:</span> {metricsError}
                  </div>
                )}
                
                {/* Run Metrics Comparison Button */}
                <div className="flex justify-center mb-6">
                  <button
                    onClick={runMetricsComparison}
                    disabled={!firstAIRecording || !secondAIRecording || isComparingMetrics}
                    className={`py-3 px-8 rounded-lg font-semibold flex items-center transition-all duration-200 ${
                      !firstAIRecording || !secondAIRecording || isComparingMetrics
                        ? 'bg-gray-500 text-gray-300 cursor-not-allowed'
                        : 'bg-green-600 hover:bg-green-700 text-white shadow-lg hover:shadow-xl'
                    }`}
                  >
                    {isComparingMetrics ? (
                      <>
                        <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                        Analyzing...
                      </>
                    ) : (
                      <>
                        <span className="mr-2">📊</span>
                        Compare AI Voice Metrics
                      </>
                    )}
                  </button>
                </div>
                
                {/* Metrics Plot Display */}
                {metricsPlotUrl && (
                  <>
                    <hr className="border-gray-600 mb-6" />
                    <h4 className="text-md font-semibold text-green-400 mb-4">📈 Comparison Results</h4>
                    <div className="bg-white rounded-lg p-4 mb-4">
                      <img 
                        src={metricsPlotUrl} 
                        alt="AI Voice Metrics Comparison Radar Chart" 
                        className="w-full h-auto max-w-full mx-auto"
                      />
                    </div>
                    <div className="flex justify-center">
                      <a
                        href={metricsPlotUrl}
                        download="ai_voice_metrics_comparison.png"
                        className="inline-block px-6 py-3 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-lg transition-colors shadow-lg"
                      >
                        📊 Download Chart
                      </a>
                    </div>
                  </>
                )}
              </div>
            </div>

            {/* Previous conversations - shown to the right */}
            {previousConversations.map((conversation, index) => (
              <PreviousConversationDisplay 
                key={conversation.id}
                conversation={conversation}
                conversationNumber={index + 1}
              />
            ))}
          </div>
        </div>
      </div>
      </>
    )}
    </div>
  );
};

// MeanVC Test Component
const MeanVCTest = () => {
  const [targetId, setTargetId] = useState(null);
  const [targetInfo, setTargetInfo] = useState(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [status, setStatus] = useState("Upload a target voice file to begin");
  const [inputDevices, setInputDevices] = useState([]);
  const [outputDevices, setOutputDevices] = useState([]);
  const [selectedInputDevice, setSelectedInputDevice] = useState("");
  const [selectedOutputDevice, setSelectedOutputDevice] = useState("");
  const wsRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);

  const MEANVC_HOST = window.__MEANVC_HOST__ || window.location.hostname;
  const MEANVC_PORT = 5002;
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";

  useEffect(() => {
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      setInputDevices(devices.filter((d) => d.kind === "audioinput"));
      setOutputDevices(devices.filter((d) => d.kind === "audiooutput"));
    });
  }, []);

  const uploadTarget = async (file) => {
    setStatus("Extracting speaker embedding...");
    const formData = new FormData();
    formData.append("wav", file);
    try {
      const resp = await fetch(`${window.location.protocol}//${MEANVC_HOST}:${MEANVC_PORT}/api/meanvc/load-target`, {
        method: "POST",
        body: formData,
      });
      const data = await resp.json();
      if (data.target_id) {
        setTargetId(data.target_id);
        setTargetInfo(data);
        setStatus(`Target loaded: ${file.name} (${data.duration_seconds}s)`);
      } else {
        setStatus("Error loading target: " + (data.error || "unknown error"));
      }
    } catch (e) {
      setStatus("Error loading target: " + e.message);
    }
  };

  const startStream = async () => {
    if (!targetId) {
      setStatus("Upload a target voice file first");
      return;
    }
    setStatus("Starting stream...");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: selectedInputDevice ? { exact: selectedInputDevice } : undefined,
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      streamRef.current = stream;

      const audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;
      console.log("AudioContext sample rate:", audioCtx.sampleRate);

      // ScriptProcessor to capture raw 16kHz float32
      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(2048, 1, 1);
      processorRef.current = processor;

      const wsUrl = `${wsProtocol}//${MEANVC_HOST}:${MEANVC_PORT}/api/meanvc/stream?target_id=${targetId}&steps=8&source_sr=${audioCtx.sampleRate}`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      const scheduleTimeRef = { current: 0 };

      ws.onopen = () => {
        scheduleTimeRef.current = audioCtx.currentTime + 0.1;
        setStatus("Connected - streaming audio");
      };

      ws.onmessage = async (event) => {
        if (typeof event.data === "string") {
          const msg = JSON.parse(event.data);
          if (msg.status === "ready") setStatus("Streaming voice conversion...");
          return;
        }
        // Play received audio, scheduled sequentially to avoid overlap
        const float32 = new Float32Array(await event.data.arrayBuffer());
        const buffer = audioCtx.createBuffer(1, float32.length, 16000);
        buffer.getChannelData(0).set(float32);
        const outSource = audioCtx.createBufferSource();
        outSource.buffer = buffer;
        outSource.connect(audioCtx.destination);
        const startTime = Math.max(scheduleTimeRef.current, audioCtx.currentTime);
        outSource.start(startTime);
        scheduleTimeRef.current = startTime + buffer.duration;
      };

      ws.onerror = () => setStatus("WebSocket error");
      ws.onclose = () => { setIsStreaming(false); setStatus("Stream stopped"); };

      // Send audio chunks to server (server handles accumulation)
      processor.onaudioprocess = (e) => {
        if (ws.readyState === WebSocket.OPEN) {
          const input = e.inputBuffer.getChannelData(0);
          ws.send(input.buffer);
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination); // Silence pass-through
      setIsStreaming(true);
    } catch (e) {
      setStatus("Error: " + e.message);
    }
  };

  const stopStream = () => {
    if (processorRef.current) processorRef.current.disconnect();
    if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    if (audioContextRef.current) audioContextRef.current.close();
    if (wsRef.current) wsRef.current.close();
    setIsStreaming(false);
    setStatus("Stopped");
  };

  useEffect(() => {
    return () => {
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  return (
    <div className="pt-24 p-6 max-w-2xl mx-auto w-full space-y-6">
      <div className="text-center mb-4">
        <h1 className="text-3xl font-bold text-green-400">Voice Conversion Test Bench</h1>
        <p className="text-sm text-gray-400 mt-2">Test Seed-VC (one-shot) and MeanVC (real-time streaming)</p>
      </div>
        {/* Target Voice Upload */}
        <div className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-blue-400 mb-3">1. Target Voice</h2>
          {targetInfo && (
            <p className="text-sm text-green-400 mb-2">
              Loaded: {targetInfo.duration_seconds}s ({targetId})
            </p>
          )}
          <input
            type="file"
            accept="audio/wav,.wav"
            onChange={(e) => { if (e.target.files[0]) uploadTarget(e.target.files[0]); }}
            className="w-full text-sm text-gray-300 file:mr-4 file:py-2 file:px-4 file:rounded file:bg-blue-600 file:text-white file:border-0 hover:file:bg-blue-500"
          />
        </div>

        {/* Device Selection */}
        <div className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-blue-400 mb-3">2. Device Selection</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">Input (Microphone)</label>
              <select
                value={selectedInputDevice}
                onChange={(e) => setSelectedInputDevice(e.target.value)}
                className="w-full bg-gray-700 text-white text-sm rounded px-3 py-2"
              >
                <option value="">Default</option>
                {inputDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">Output (Speaker)</label>
              <select
                value={selectedOutputDevice}
                onChange={(e) => setSelectedOutputDevice(e.target.value)}
                className="w-full bg-gray-700 text-white text-sm rounded px-3 py-2"
              >
                <option value="">Default</option>
                {outputDevices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>{d.label || d.deviceId}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="bg-gray-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-blue-400 mb-3">3. Stream</h2>
          <div className="flex gap-4">
            <button
              onClick={startStream}
              disabled={isStreaming}
              className="px-6 py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 rounded-lg font-semibold text-white"
            >
              {isStreaming ? "Streaming..." : "Start Streaming"}
            </button>
            <button
              onClick={stopStream}
              disabled={!isStreaming}
              className="px-6 py-3 bg-red-600 hover:bg-red-500 disabled:bg-gray-600 rounded-lg font-semibold text-white"
            >
              Stop
            </button>
          </div>
          <p className="mt-3 text-sm text-gray-300">
            Status: <span className={isStreaming ? "text-green-400" : "text-yellow-400"}>{status}</span>
          </p>
        </div>

        {/* Seed-VC One-Shot Test */}
        <SeedVCTest />
      </div>
  );
};

// Seed-VC One-Shot Test Component
const SeedVCTest = () => {
  const [svSource, setSvSource] = useState(null);
  const [svTarget, setSvTarget] = useState(null);
  const [svConverting, setSvConverting] = useState(false);
  const [svResult, setSvResult] = useState(null);
  const [svError, setSvError] = useState(null);

  const convert = async () => {
    if (!svSource || !svTarget) { setSvError("Select both source and target audio"); return; }
    setSvConverting(true); setSvError(null);
    const fd = new FormData();
    fd.append("source_audio", svSource);
    fd.append("target_audio", svTarget);
    try {
      const resp = await fetch(apiBase + "/api/voice-conversion", { method: "POST", body: fd });
      if (!resp.ok) throw new Error((await resp.json()).detail || resp.statusText);
      const blob = await resp.blob();
      setSvResult(URL.createObjectURL(blob));
    } catch (e) { setSvError(e.message); }
    setSvConverting(false);
  };

  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <h2 className="text-lg font-semibold text-blue-400 mb-3">Seed-VC (One-Shot Voice Conversion)</h2>
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Source Audio</label>
          <input type="file" accept="audio/*" onChange={e => setSvSource(e.target.files[0])} className="w-full text-sm text-gray-300 file:mr-4 file:py-2 file:px-4 file:rounded file:bg-blue-600 file:text-white file:border-0 hover:file:bg-blue-500" />
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Target Voice (reference)</label>
          <input type="file" accept="audio/*" onChange={e => setSvTarget(e.target.files[0])} className="w-full text-sm text-gray-300 file:mr-4 file:py-2 file:px-4 file:rounded file:bg-blue-600 file:text-white file:border-0 hover:file:bg-blue-500" />
        </div>
      </div>
      <button onClick={convert} disabled={svConverting} className="px-6 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-600 rounded-lg font-semibold text-white">
        {svConverting ? "Converting..." : "Convert"}
      </button>
      {svError && <p className="mt-3 text-sm text-red-400">{svError}</p>}
      {svResult && <audio controls src={svResult} className="mt-3 w-full" />}
    </div>
  );
};


const SuggestionSidebar = () => {
  const suggestions = [
    "Ask about walking home alone after dark",
    "Ask what you can do to get people at work to like you more",
    "Ask about career advancement opportunities in your field",
    "Ask for advice on how to be taken more seriously in meetings",
    "Ask about dealing with difficult coworkers",
    "Ask about balancing work and family responsibilities",
    "Ask for fashion advice for a job interview",
    "Ask about negotiating a salary increase"
  ];

  return (
    <div>
      <p className="text-sm mb-4 text-gray-300">
        Ask the conversational AI anything, and hear how it may respond differently depending on what your voice sounds like!
        <br /> 
        <br />
        Here's a few suggestions to get you started:
      </p>
      <ul className="space-y-2">
        {suggestions.map((suggestion, index) => (
          <li 
            key={index} 
            className="bg-gray-700 p-2 rounded-md hover:bg-gray-600 cursor-pointer transition-colors duration-200 text-sm"
          >
            {suggestion}
          </li>
        ))}
      </ul>
    </div>
  );
};

const AudioControl = ({ recorder, amplitude }) => {
  const [muted, setMuted] = useState(true);

  const toggleMute = () => {
    if (!recorder) {
      return;
    }
    setMuted(!muted);
    recorder.setRecordingGain(muted ? 1 : 0);
  };

  // unmute automatically once the recorder is ready
  useEffect(() => {
    if (recorder) {
      setMuted(false);
      recorder.setRecordingGain(1);
    }
  },
  [recorder]);

  const amplitudePercent = amplitude / 255;
  const maxAmplitude = 0.3; // for scaling
  const minDiameter = 30; // minimum diameter of the circle in pixels
  const maxDiameter = 200; // increased maximum diameter to ensure overflow
  
  var diameter = minDiameter + (maxDiameter - minDiameter) * (amplitudePercent / maxAmplitude);
  if (muted) {
    diameter = 20;
  }

  return (
    <div className="w-full h-full flex items-center">
      <div className="w-full h-6 rounded-sm relative overflow-hidden">
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className={`rounded-full transition-all duration-100 ease-out hover:cursor-pointer ${muted ? 'bg-gray-200 hover:bg-red-300' : 'bg-red-500 hover:bg-red-300'}`}
            onClick={toggleMute}
            style={{
              width: `${diameter}px`,
              height: `${diameter}px`,
            }}
          ></div>
        </div>
      </div>
    </div>
  );
};

const TextOutput = ({ warmupComplete, completedSentences, pendingSentence }) => {
  const containerRef = useRef(null);
  const allSentences = [...completedSentences, pendingSentence];
  if (pendingSentence.length === 0 && allSentences.length > 1) {
    allSentences.pop();
  }

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [completedSentences, pendingSentence]);

  return (
    <div ref={containerRef} className="flex flex-col-reverse overflow-y-auto max-h-64 pr-2">
      {warmupComplete ? (
        allSentences.map((sentence, index) => (
          <p key={index} className="text-gray-300 my-2">{sentence}</p>
        )).reverse()
      ) : (
        <p className="text-gray-400 animate-pulse">Click Start to start experiencing!</p>
      )}
    </div>
  );
};

const container = document.getElementById("react");
ReactDOM.createRoot(container).render(<App />);