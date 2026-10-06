import { useState } from "react";
import { AccountsPanel } from "./components/AccountsPanel";
import { AdapterPanel } from "./components/AdapterPanel";
import { Chat } from "./components/Chat";
import { HudBar } from "./components/HudBar";
import { ProjectPanel } from "./components/ProjectPanel";
import { ResizableGroup, ResizableHandle, ResizablePanel } from "./components/ResizableDivider";
import { useWs } from "./context/WebSocketProvider";

export default function App() {
  const { connected } = useWs();
  const [rightOpen, setRightOpen] = useState(true);

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-surface-0">
      <HudBar />
      {/* Left — Adapters */}
      <ResizableGroup direction="horizontal" className="min-h-0 flex-1 overflow-hidden">
        <ResizablePanel defaultSize={16} minSize={10} maxSize={30}>
          <aside className="border-r border-edge flex h-full flex-col bg-surface-1">
            <header className="flex items-center gap-3 px-5 py-4">
              <span className="font-mono text-xs font-medium tracking-tight text-text-primary">
                orquestador
              </span>
              <div
                className={`ml-auto h-1.5 w-1.5 rounded-full ${connected ? "bg-ok animate-pulse-dot" : "bg-err"}`}
                title={connected ? "conectado" : "desconectado"}
              />
            </header>
            <div className="flex-1 overflow-y-auto">
              <AdapterPanel />
              <AccountsPanel />
            </div>
          </aside>
        </ResizablePanel>

        <ResizableHandle direction="horizontal" />

        {/* Center — Chat (no absolute overlays here) */}
        <ResizablePanel defaultSize={rightOpen ? 62 : 84} minSize={30}>
          <main className="flex h-full flex-col min-w-0">
            <Chat />
          </main>
        </ResizablePanel>

        {/* Right — Projects (collapsible) */}
        {rightOpen && (
          <>
            <ResizableHandle direction="horizontal" />
            <ResizablePanel defaultSize={22} minSize={12} maxSize={35}>
              <aside className="border-l border-edge flex h-full flex-col bg-surface-1">
                <ProjectPanel onClose={() => setRightOpen(false)} />
              </aside>
            </ResizablePanel>
          </>
        )}
      </ResizableGroup>

      {/* Fixed toggle button — bottom-right, never overlaps content */}
      <button
        onClick={() => setRightOpen((o) => !o)}
        title={rightOpen ? "Ocultar proyectos" : "Mostrar proyectos"}
        className="fixed bottom-4 right-4 z-30 flex items-center gap-1.5 px-2.5 py-1.5 bg-surface-1 border border-edge rounded-lg font-mono text-[10px] text-text-tertiary hover:text-text-primary hover:bg-surface-2 transition-all shadow-sm"
      >
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className={`transition-transform ${rightOpen ? "" : "rotate-180"}`}>
          <path d="M8 2L4 6L8 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        proyectos
      </button>
    </div>
  );
}
