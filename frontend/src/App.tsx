import { useState } from "react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ConversationView } from "@/components/ConversationView"
import { VoiceConversion } from "@/components/VoiceConversion"
import { MetricsComparison } from "@/components/MetricsComparison"
import { useRecorder } from "@/hooks/useRecorder"
import { useWebSocket } from "@/hooks/useWebSocket"
import { useSpeechRecognition } from "@/hooks/useSpeechRecognition"
import { Mic, GitCompare, Wand2 } from "lucide-react"

function App() {
  const ws = useWebSocket()
  const recorder = useRecorder((data) => ws.sendAudio(data))
  const speech = useSpeechRecognition()
  const [activeTab, setActiveTab] = useState("conversation")

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col px-4 py-6 sm:px-8 sm:py-8">
      <header className="mb-6 flex flex-col gap-1 sm:mb-8 sm:flex-row sm:items-baseline sm:gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Hear Me Out</h1>
        <p className="text-sm text-muted-foreground">Speech-to-speech evaluation platform</p>
      </header>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-1 flex-col">
        <TabsList className="mb-5 w-fit" variant="line">
          <TabsTrigger value="conversation" className="gap-1.5">
            <Mic />Chat
          </TabsTrigger>
          <TabsTrigger value="voice-conversion" className="gap-1.5">
            <Wand2 />Convert
          </TabsTrigger>
          <TabsTrigger value="metrics" className="gap-1.5">
            <GitCompare />Metrics
          </TabsTrigger>
        </TabsList>

        <TabsContent value="conversation" className="flex-1">
          <ConversationView ws={ws} recorder={recorder} speech={speech} />
        </TabsContent>
        <TabsContent value="voice-conversion">
          <div className="mx-auto max-w-lg">
            <VoiceConversion sourceChunks={recorder.recordedChunks} />
          </div>
        </TabsContent>
        <TabsContent value="metrics">
          <div className="mx-auto max-w-lg">
            <MetricsComparison />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default App