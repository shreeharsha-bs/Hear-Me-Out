import { useState } from "react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ConversationView } from "@/components/ConversationView"
import { VoiceConversion } from "@/components/VoiceConversion"
import { MetricsComparison } from "@/components/MetricsComparison"
import { useRecorder } from "@/hooks/useRecorder"
import { useWebSocket } from "@/hooks/useWebSocket"
import { Mic, GitCompare, Wand2 } from "lucide-react"

function App() {
  const ws = useWebSocket()
  const recorder = useRecorder((data) => ws.sendAudio(data))
  const [activeTab, setActiveTab] = useState("conversation")

  return (
    <div className="mx-auto flex max-w-6xl flex-col px-4 py-4 sm:px-8 sm:py-6 h-screen overflow-hidden">
      <header className="mb-4 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3 sm:mb-5">
        <h1 className="text-2xl font-semibold tracking-tight">Hear Me Out</h1>
        <p className="text-sm text-muted-foreground">Speech-to-speech evaluation platform</p>
      </header>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-1 flex-col min-h-0">
        <TabsList className="mb-4 w-fit" variant="line">
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

        <TabsContent value="conversation" className="flex-1 min-h-0">
          <ConversationView ws={ws} recorder={recorder} />
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