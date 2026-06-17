import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { TooltipProvider } from './components/ui/tooltip'
import { ThemeProvider } from './hooks/useTheme'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
)
