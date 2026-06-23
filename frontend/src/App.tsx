import { useState } from "react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ConversationView } from "@/components/ConversationView"
import { VoiceConversion } from "@/components/VoiceConversion"
import { MetricsComparison } from "@/components/MetricsComparison"
import { useRecorder } from "@/hooks/useRecorder"
import { useWebSocket } from "@/hooks/useWebSocket"
import { ThemeToggle } from "@/components/ThemeToggle"
import { Mic, GitCompare, Wand2 } from "lucide-react"

function App() {
  const ws = useWebSocket()
  const recorder = useRecorder((data) => ws.sendAudio(data))
  const [activeTab, setActiveTab] = useState("conversation")


  return (
    <div className="mx-auto flex max-w-6xl flex-col px-4 py-4 sm:px-8 sm:py-6 h-screen overflow-hidden">
      <header className="mb-4 flex items-center gap-4 sm:mb-5">
        <img src="/KTH_Logo.jpg" alt="KTH Logo" className="h-16 sm:h-20 flex-shrink-0" />
        <div className="flex flex-col gap-0.5 min-w-0 flex-1">
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">Hear Me Out</h1>
          <p className="text-xs sm:text-sm text-foreground/80 leading-snug">
            Interactive evaluation and bias discovery platform for speech-to-speech conversational AI
          </p>
          <p className="text-[11px] sm:text-xs text-foreground/60">
            KTH Royal Institute of Technology, Stockholm, Sweden
          </p>
        </div>
        <ThemeToggle />
      </header>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-1 flex-col min-h-0">
        <TabsList className="mb-4 w-full !flex !flex-row">
          <TabsTrigger
            value="conversation"
            className={`flex-1 gap-1.5 rounded-md ${activeTab === "conversation" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground"}`}
          >
            <Mic />Chat
          </TabsTrigger>
          <TabsTrigger
            value="voice-conversion"
            className={`flex-1 gap-1.5 rounded-md ${activeTab === "voice-conversion" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground"}`}
          >
            <Wand2 />Convert
          </TabsTrigger>
          <TabsTrigger
            value="metrics"
            className={`flex-1 gap-1.5 rounded-md ${activeTab === "metrics" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground"}`}
          >
            <GitCompare />Metrics
          </TabsTrigger>
        </TabsList>

        <TabsContent value="conversation" className="flex-1 min-h-0">
          <ConversationView ws={ws} recorder={recorder} />
        </TabsContent>
        <TabsContent value="voice-conversion" className="flex-1 min-h-0 overflow-y-auto">
          <div className="mx-auto max-w-lg pb-6">
            <VoiceConversion />
          </div>
        </TabsContent>
        <TabsContent value="metrics" className="flex-1 min-h-0 overflow-y-auto">
          <div className="mx-auto max-w-lg pb-6">
            <MetricsComparison />
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default App