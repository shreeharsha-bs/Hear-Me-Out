const { useRef, useEffect, useState } = React;

const baseURL = "" // points to whatever is serving this app (eg your -dev.modal.run for modal serve, or .modal.run for modal deploy)

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

const getBaseURL = () => {
  // use current web app server domain to construct the url for the moshi app
  const currentURL = new URL(window.location.href);
  let hostname = currentURL.hostname;
  hostname = hostname.replace('-web', '-moshi-web');
  const wsProtocol = currentURL.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${wsProtocol}//${hostname}/ws`; 
}

const App = () => {
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

  // Mic Input: start the Opus recorder
  const startRecording = async () => {
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
        await socketRef.current.send(arrayBuffer);
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
      
      // Download the WAV file
      const url = URL.createObjectURL(wavBlob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      a.download = `hear-me-out-user-voice-${getTimestamp()}.wav`;
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
        
        // Download the WAV file
        const url = URL.createObjectURL(wavBlob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `hear-me-out-ai-voice-${getTimestamp()}.wav`;
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

    const endpoint = getBaseURL();
    console.log("Connecting to", endpoint);
    const socket = new WebSocket(endpoint);
    socketRef.current = socket;

    socket.onopen = () => {
      console.log("WebSocket connection opened");
      startRecording();
      setWarmupComplete(true);
    };

    socket.onmessage = async (event) => {
      // data is a blob, convert to array buffer
      const arrayBuffer = await event.data.arrayBuffer();
      const view = new Uint8Array(arrayBuffer);
      const tag = view[0];
      const payload = arrayBuffer.slice(1);
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

      const response = await fetch('http://127.0.0.1:5001/api/voice-conversion', {
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

  return (
    <div className="bg-gray-900 text-white min-h-screen flex flex-col">
      <header className="w-full flex items-center p-4 bg-gray-800 fixed top-0 left-0 z-10">
        <img src="./KTH_Logo.jpg" alt="KTH Logo" className="h-20 mr-4" />
        <div>
          <h1 className="text-3xl font-bold">Hear Me Out</h1>
          <h2 className="text-xl">Interactive evaluation and bias discovery platform for
          speech-to-speech conversational AI</h2>
          <h3 className="text-lg">KTH Royal Institute of Technology, Stockholm, Sweden</h3>
        </div>
      </header>
      
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
                          Download Converted Audio
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
                      <span className="mr-1">💬</span> Save Your Voice
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
    </div>
  );
}

const PreviousConversationDisplay = ({ conversation, conversationNumber }) => {
  const allSentences = [...conversation.completedSentences];
  if (conversation.pendingSentence.trim() !== '') {
    allSentences.push(conversation.pendingSentence);
  }

  // Remove empty last sentence if it exists
  if (allSentences.length > 1 && allSentences[allSentences.length - 1].trim() === '') {
    allSentences.pop();
  }

  return (
    <div className="min-w-[32rem] max-w-2xl">
      <div className="bg-gray-800 rounded-lg shadow-lg w-full p-6 flex flex-col items-center border-l-4 border-blue-300">
        <div className="flex w-full mb-2">
          <h3 className="text-lg font-semibold text-blue-300">
            Response to Original Voice (Conversation {conversationNumber})
          </h3>
        </div>
        <div className="w-full">
          <div className="flex flex-col-reverse overflow-y-auto max-h-64 pr-2">
            {conversation.warmupComplete ? (
              allSentences.length > 0 ? (
                allSentences.map((sentence, index) => (
                  <p key={index} className="text-gray-300 my-2">{sentence}</p>
                )).reverse()
              ) : (
                <p className="text-gray-400 italic">No responses recorded</p>
              )
            ) : (
              <p className="text-gray-400 italic">Conversation was not completed</p>
            )}
          </div>
        </div>
      </div>
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