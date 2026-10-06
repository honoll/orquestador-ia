import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

interface AppState {
  selectedAdapter: string;
  selectedModel: string;
  selectedProjectId: string | null;
  conversationId: string | null;
  activePlanId: string | null;
  setAdapter: (adapter: string, model?: string) => void;
  setModel: (model: string) => void;
  setProject: (projectId: string | null) => void;
  setConversation: (id: string | null) => void;
  setActivePlanId: (id: string | null) => void;
  newChat: () => void;
}

const AppStateContext = createContext<AppState>({
  selectedAdapter: "claude",
  selectedModel: "",
  selectedProjectId: null,
  conversationId: null,
  activePlanId: null,
  setAdapter: () => {},
  setModel: () => {},
  setProject: () => {},
  setConversation: () => {},
  setActivePlanId: () => {},
  newChat: () => {},
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
        setAdapter,
        setModel,
        setProject,
        setConversation,
        setActivePlanId,
        newChat,
      }}
    >
      {children}
    </AppStateContext.Provider>
  );
}
