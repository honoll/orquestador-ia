import { useState } from "react";
import { AccountsPanel } from "./components/AccountsPanel";
import { WorkerIsolationNotice } from "./components/WorkerIsolationNotice";
import { MemoryStatus } from "./components/MemoryStatus";
import { AdapterPanel } from "./components/AdapterPanel";
import { Chat } from "./components/Chat";
import { HudBar } from "./components/HudBar";
import { ProjectPanel } from "./components/ProjectPanel";
import { ResizableGroup, ResizableHandle, ResizablePanel } from "./components/ResizableDivider";
import { useAppState } from "./context/AppStateContext";
import { OfficeView } from "./components/office/OfficeView";
import { RolesView } from "./components/RolesView";

export default function App() {
  const [rightOpen, setRightOpen] = useState(true);
  const { view } = useAppState();
  // "office" = la vista ocupa centro + derecha (Oficina o Roles); Chat queda montado y oculto.
  const office = view !== "chat";

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-surface-0">
      <HudBar />
      {/* Left — Adapters */}
      <ResizableGroup direction="horizontal" className="min-h-0 flex-1 overflow-hidden">
        <ResizablePanel defaultSize={16} minSize={10} maxSize={30}>
          <aside className="px-grid border-r-[3px] border-edge flex h-full flex-col bg-surface-1">
            <div className="flex-1 overflow-y-auto overflow-x-hidden pt-3">
              <AdapterPanel />
              <AccountsPanel />
              <WorkerIsolationNotice />
              <MemoryStatus />
            </div>
          </aside>
        </ResizablePanel>

        <ResizableHandle direction="horizontal" />

        {/* Center — Chat (no absolute overlays here); en Oficina, centro + derecha = OfficeView.
            Chat sigue montado (oculto) para no perder un stream en curso. */}
        <ResizablePanel defaultSize={rightOpen && !office ? 62 : 84} minSize={30}>
          <main className={`h-full flex-col min-w-0 ${office ? "hidden" : "flex"}`}>
            <Chat />
          </main>
          {view === "oficina" && <OfficeView />}
          {view === "roles" && <RolesView />}
        </ResizablePanel>

        {/* Right — Projects (collapsible) */}
        {rightOpen && !office && (
          <>
            <ResizableHandle direction="horizontal" />
            <ResizablePanel defaultSize={22} minSize={12} maxSize={35}>
              <aside className="px-grid border-l-[3px] border-edge flex h-full flex-col bg-surface-1">
                <ProjectPanel onClose={() => setRightOpen(false)} />
              </aside>
            </ResizablePanel>
          </>
        )}
      </ResizableGroup>

      {/* Fixed toggle button — bottom-right, never overlaps content */}
      {!office && (
        <button
          onClick={() => setRightOpen((o) => !o)}
          title={rightOpen ? "Ocultar proyectos" : "Mostrar proyectos"}
          className="px-btn fixed bottom-4 right-4 z-30"
        >
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none" className={`transition-transform ${rightOpen ? "" : "rotate-180"}`}>
            <path d="M8 2L4 6L8 10" stroke="currentColor" strokeWidth="2" strokeLinecap="square"/>
          </svg>
          PROYECTOS
        </button>
      )}
    </div>
  );
}
