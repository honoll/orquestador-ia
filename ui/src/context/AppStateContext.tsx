import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { readView, VIEW_KEY, type View } from "../lib/office-view";

interface AppState {
  selectedAdapter: string;
  selectedModel: string;
  selectedProjectId: string | null;
  conversationId: string | null;
  activePlanId: string | null;
  view: View;
  setView: (view: View) => void;
  /** «Platicar» abierto: la Oficina ocultaría sus controles con el micrófono abierto. */
  talkActive: boolean;
  setTalkActive: (on: boolean) => void;
  setAdapter: (adapter: string, model?: string) => void;
  setModel: (model: string) => void;
  setProject: (projectId: string | null) => void;
  setConversation: (id: string | null) => void;
  setActivePlanId: (id: string | null) => void;
  newChat: () => void;
  /** F15: la barra pide a la vista Equipo abrir esta meta y tarea. */
  equipoFocus: { metaId: string; tareaId: string } | null;
  setEquipoFocus: (f: { metaId: string; tareaId: string } | null) => void;
}

const AppStateContext = createContext<AppState>({
  selectedAdapter: "claude",
  selectedModel: "",
  selectedProjectId: null,
  conversationId: null,
  activePlanId: null,
  view: "chat",
  setView: () => {},
  talkActive: false,
  setTalkActive: () => {},
  setAdapter: () => {},
  setModel: () => {},
  setProject: () => {},
  setConversation: () => {},
  setActivePlanId: () => {},
  newChat: () => {},
  equipoFocus: null,
  setEquipoFocus: () => {},
});

export function useAppState() {
  return useContext(AppStateContext);
}

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [selectedAdapter, setSelectedAdapter] = useState("claude");
  const [selectedModel, setSelectedModel] = useState("");
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [activePlanId, setActivePlanIdState] = useState<string | null>(null);
  const [view, setViewState] = useState<View>(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem(VIEW_KEY); } catch { /* almacenamiento bloqueado */ }
    return readView(window.location.search, stored);
  });

  const [talkActive, setTalkActive] = useState(false);
  const [equipoFocus, setEquipoFocus] = useState<{ metaId: string; tareaId: string } | null>(null);
  const setView = useCallback((v: View) => {
    setViewState(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* almacenamiento bloqueado */ }
  }, []);

  const setAdapter = useCallback((adapter: string, model?: string) => {
    setSelectedAdapter(adapter);
    setSelectedModel(model ?? "");
  }, []);

  const setModel = useCallback((model: string) => {
    setSelectedModel(model);
  }, []);

  const setProject = useCallback((projectId: string | null) => {
    setSelectedProjectId(projectId);
    // Reset conversation and plan when switching projects
    setConversationId(null);
    setActivePlanIdState(null);
  }, []);

  const setConversation = useCallback((id: string | null) => {
    setConversationId(id);
  }, []);

  const setActivePlanId = useCallback((id: string | null) => {
    setActivePlanIdState(id);
  }, []);

  const newChat = useCallback(() => {
    setConversationId(null);
    setActivePlanIdState(null);
  }, []);

  return (
    <AppStateContext.Provider
      value={{
        selectedAdapter,
        selectedModel,
        selectedProjectId,
        conversationId,
        activePlanId,
        view,
        setView,
        talkActive,
        setTalkActive,
        setAdapter,
        setModel,
        setProject,
        setConversation,
        setActivePlanId,
        newChat,
        equipoFocus,
        setEquipoFocus,
      }}
    >
      {children}
    </AppStateContext.Provider>
  );
}
