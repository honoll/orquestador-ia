import { useEffect, useRef, useState } from "react";
import { useWs } from "../context/WebSocketProvider";
import { createVad, float32ToWav, type VadHandle } from "../lib/vad";
import {
  CONV_IDLE_MS,
  convReducer,
  createMaxSpeechTimer,
  createSpeechQueue,
  initialConv,
  type ConvEvent,
  type ConvPhase,
  type ConvState,
} from "../lib/conversation";
import { createSentenceStreamer } from "../lib/sentences";
import {
  createFinishAfterSpeech,
  endSession,
  endSessionBeacon,
  interruptSession,
  parseAssistantEvent,
  postTurn,
  readBargeIn,
  startSession,
  turnDoneSpeech,
  writeBargeIn,
} from "../lib/assistant";
import { duckLease } from "../lib/duck";
import { fetchSentence, playSpeechBlob, stopSpeech, transcribe } from "../lib/voice";
import { micErrorMessage } from "../lib/voice-utils";

export interface ConversationResult {
  conversationId: string | null;
  notePath: string | null;
  /** Último plan de voz que quedó esperando aprobación en pantalla (el chat lo abre en PlanView). */
  approvalPlanId?: string | null;
}

interface Line {
  id: number;
  who: "tu" | "asistente";
  text: string;
}

const MAX_LINES = 6;
const BUSY_RETRIES = 20;
const BUSY_RETRY_MS = 700;

const PHASE_LABEL: Record<ConvPhase, string> = {
  starting: "Preparando…",
  listening: "Escuchando",
  transcribing: "Transcribiendo",
  thinking: "Pensando",
  speaking: "Hablando",
  ending: "Terminando…",
  ended: "Terminada",
  error: "No se pudo continuar",
};

const PHASE_STYLE: Record<ConvPhase, string> = {
  starting: "border-edge-strong text-text-secondary",
  listening: "border-accent text-accent animate-pulse",
  transcribing: "border-edge-strong text-text-primary",
  thinking: "border-edge-strong text-text-primary animate-pulse",
  speaking: "border-ok text-ok",
  ending: "border-edge-strong text-text-secondary",
  ended: "border-edge-strong text-text-secondary",
  error: "border-err text-err",
};

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * «Platicar»: conversación de voz sin manos. Micrófono → VAD → Whisper → asistente → frases → Piper.
 * Toda la lógica vive en un único efecto con referencias; el componente solo pinta.
 */
export function ConversationView({
  projectId,
  onClose,
}: {
  projectId: string | null;
  onClose: (result: ConversationResult) => void;
}) {
  const { subscribe } = useWs();
  const [conv, setConv] = useState<ConvState>(() => initialConv(Date.now()));
  const [lines, setLines] = useState<Line[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [bargeIn, setBargeIn] = useState(() => readBargeIn(safeStorage()));
  const convRef = useRef(conv);
  const bargeRef = useRef(bargeIn);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const api = useRef<{ interrupt(): void; end(): void; rebuildVad(): void; dismiss(): void } | null>(null);
  const circleRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let closed = false;
    let sessionId: string | null = null;
    let conversationId: string | null = null;
    let stream: MediaStream | null = null;
    let vad: VadHandle | null = null;
    let unsub: (() => void) | null = null;
    let idleTimer: ReturnType<typeof setInterval> | null = null;
    let transcribeCtl: AbortController | null = null;
    // Turno en curso y turnos interrumpidos (sus deltas se ignoran).
    const ignored = new Set<string>();
    let curTurn: string | null = null;
    let turnSeq = 0;
    let interruptedSeq = -1;
    let turnSentences = 0;
    let lineId = 0;
    let approvalPlanId: string | null = null;
    const lease = duckLease("conversation");

    const addLine = (who: Line["who"], text: string, append = false) => {
      setLines((prev) => {
        const last = prev[prev.length - 1];
        if (append && last && last.who === who) {
          return [...prev.slice(0, -1), { ...last, text: `${last.text} ${text}` }];
        }
        return [...prev, { id: ++lineId, who, text }].slice(-MAX_LINES);
      });
    };

    const dispatch = (e: ConvEvent) => {
      const prev = convRef.current;
      const next = convReducer(prev, e, Date.now(), { bargeIn: bargeRef.current });
      if (next === prev) return;
      convRef.current = next;
      setConv(next);
      if (next.micOpen && !prev.micOpen) vad?.start();
      else if (!next.micOpen && prev.micOpen) vad?.pause();
      if (next.phase === "ending" && prev.phase !== "ending") void doEnd();
    };

    // Frase máxima: si el usuario sigue hablando a los 60 s, se cierra la frase y se transcribe lo capturado.
    const maxSpeech = createMaxSpeechTimer({
      onExpire: () => {
        if (closed || convRef.current.phase !== "listening") return;
        // pause() entrega la frase (submitUserSpeechOnPause) → onSpeechEnd → transcribing.
        vad?.pause();
        setTimeout(() => {
          // Si no había frase que entregar, el micrófono sigue abierto.
          if (!closed && convRef.current.phase === "listening") vad?.start();
        }, 300);
      },
    });

    const queue = createSpeechQueue({ fetch: fetchSentence, play: playSpeechBlob });
    // Fin decidido por el servidor (cuota, agy perdido, frase de cierre): se cierra al terminar de hablar.
    const finishAfterSpeech = createFinishAfterSpeech({ idle: () => queue.idle() });
    let closing = false;
    queue.onIdle(() => {
      finishAfterSpeech.notifyIdle();
      dispatch({ type: "speakIdle" });
    });

    const onSentence = (s: string) => {
      turnSentences++;
      addLine("asistente", s, turnSentences > 1);
      dispatch({ type: "speakQueued" });
      queue.enqueue(s);
    };
    let streamer = createSentenceStreamer(onSentence);

    const releaseResources = () => {
      finishAfterSpeech.cancel();
      maxSpeech.cancel();
      if (idleTimer) clearInterval(idleTimer);
      idleTimer = null;
      unsub?.();
      unsub = null;
      transcribeCtl?.abort();
      queue.stop();
      stopSpeech();
      try { vad?.destroy(); } catch { /* ya liberado */ }
      vad = null;
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
      lease.stop();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pagehide", onPageHide);
    };

    const finish = (notePath: string | null) => {
      if (closed) return;
      closed = true;
      releaseResources();
      onCloseRef.current({ conversationId, notePath, approvalPlanId });
    };

    const fail = (message: string, endRemote: boolean) => {
      if (closed) return;
      closed = true;
      const id = sessionId;
      releaseResources();
      if (endRemote && id) void endSession(id).catch(() => {});
      dispatch({ type: "fail", message });
    };

    async function doEnd() {
      if (!sessionId) return finish(null);
      try {
        const r = await endSession(sessionId);
        finish(r.notePath);
      } catch {
        finish(null);
      }
    }

    function interrupt() {
      const p = convRef.current.phase;
      if (p !== "speaking" && p !== "thinking") return;
      if (curTurn) ignored.add(curTurn);
      else interruptedSeq = turnSeq;
      curTurn = null;
      streamer = createSentenceStreamer(onSentence);
      maxSpeech.cancel();
      queue.stop();
      stopSpeech();
      // Lo que se dejó de oír no se puede confirmar: el servidor descarta la acción pendiente.
      if (sessionId && !closing) void interruptSession(sessionId).catch(() => {});
      dispatch({ type: "interrupt" });
      if (closing) finishAfterSpeech.notifyIdle(); // cortar el aviso final cierra ya
    }

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        interrupt();
        return;
      }
      if (e.key === " " || e.code === "Space") {
        const t = e.target as HTMLElement | null;
        // En campos de texto y botones el espacio conserva su función normal.
        if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(t.tagName))) return;
        e.preventDefault();
        interrupt();
      }
    }

    function onPageHide() {
      if (closed || !sessionId) return;
      closed = true;
      endSessionBeacon(sessionId);
      releaseResources();
    }

    async function makeVad(): Promise<VadHandle> {
      return createVad({
        stream: stream as MediaStream,
        strict: bargeRef.current,
        onSpeechStart: () => {
          const p = convRef.current.phase;
          if (p === "speaking" && bargeRef.current) interrupt();
          else dispatch({ type: "speechStart" });
          if (convRef.current.phase === "listening") maxSpeech.start();
        },
        onMisfire: () => maxSpeech.cancel(),
        onSpeechEnd: (audio) => {
          maxSpeech.cancel();
          if (convRef.current.phase !== "listening") return;
          dispatch({ type: "speechEnd" });
          void handleUtterance(audio);
        },
      });
    }

    async function handleUtterance(audio: Float32Array) {
      const ctl = new AbortController();
      transcribeCtl = ctl;
      let text: string;
      try {
        text = (await transcribe(float32ToWav(audio), ctl.signal)).trim();
      } catch (err) {
        if (ctl.signal.aborted || closed) return;
        setNotice(`No se pudo transcribir: ${(err as Error).message}`);
        dispatch({ type: "discarded" });
        return;
      }
      if (closed || closing || ctl.signal.aborted) return;
      if (!text) return dispatch({ type: "discarded" });
      setNotice(null);
      const seq = ++turnSeq;
      curTurn = null;
      turnSentences = 0;
      streamer = createSentenceStreamer(onSentence);
      addLine("tu", text);
      dispatch({ type: "transcribed", text });
      const stillMine = () => !closed && seq === turnSeq && convRef.current.phase === "thinking";
      for (let attempt = 0; ; attempt++) {
        let outcome;
        try {
          outcome = await postTurn(sessionId as string, text);
        } catch (err) {
          if (stillMine()) {
            setNotice(`No se pudo enviar lo que dijiste: ${(err as Error).message}`);
            dispatch({ type: "interrupt" });
          }
          return;
        }
        if (outcome.kind === "accepted") {
          if (seq !== turnSeq || interruptedSeq === seq) ignored.add(outcome.turnId);
          else if (!curTurn) curTurn = outcome.turnId;
          return;
        }
        if (outcome.kind === "discarded") {
          if (stillMine()) dispatch({ type: "interrupt" });
          return;
        }
        // Tras interrumpir, el turno anterior puede seguir cerrándose en el servidor: se reintenta.
        if (/turno en curso/i.test(outcome.message) && attempt < BUSY_RETRIES && stillMine()) {
          await sleep(BUSY_RETRY_MS);
          if (!stillMine()) return;
          continue;
        }
        if (stillMine()) {
          setNotice(outcome.message);
          dispatch({ type: "interrupt" });
        }
        return;
      }
    }

    function onWs(raw: unknown) {
      if (!sessionId) return;
      const ev = parseAssistantEvent(raw, sessionId);
      if (!ev) return;
      if (ev.type === "ended") {
        // Terminar pedido por el usuario: cierra ya. Fin del servidor: primero se oye el último aviso.
        if (convRef.current.phase === "ending") return finish(ev.notePath);
        closing = true;
        maxSpeech.cancel();
        vad?.pause();
        const notePath = ev.notePath;
        finishAfterSpeech.request(() => finish(notePath));
        return;
      }
      if (ev.type === "announce") {
        addLine("asistente", ev.text);
        if (ev.needsApproval && ev.planId) approvalPlanId = ev.planId;
        if (convRef.current.phase === "listening") dispatch({ type: "announce" });
        else dispatch({ type: "speakQueued" });
        queue.enqueue(ev.text);
        return;
      }
      const phase = convRef.current.phase;
      if (phase !== "thinking" && phase !== "speaking") return;
      if (ignored.has(ev.turnId)) return;
      if (curTurn === null) {
        if (interruptedSeq === turnSeq) {
          ignored.add(ev.turnId);
          return;
        }
        curTurn = ev.turnId;
      } else if (curTurn !== ev.turnId) {
        return;
      }
      if (ev.type === "delta") {
        streamer.push(ev.delta);
        return;
      }
      // turn-done
      streamer.flush();
      // También con error: el aviso del servidor (cuota, conexión perdida) se dice en voz.
      const say = turnDoneSpeech(ev, turnSentences);
      if (say) onSentence(say);
      if (ev.error) setNotice(ev.error);
      curTurn = null;
      dispatch({ type: "turnDone", hasAudio: turnSentences > 0 });
    }

    api.current = {
      interrupt,
      end: () => dispatch({ type: "end" }),
      dismiss: () => {
        closed = true;
        onCloseRef.current({ conversationId, notePath: null, approvalPlanId });
      },
      rebuildVad: () => {
        if (!vad || closed || !stream) return;
        const old = vad;
        vad = null;
        old.destroy();
        void makeVad().then((v) => {
          if (closed) return v.destroy();
          vad = v;
          if (convRef.current.micOpen) v.start();
        }).catch(() => fail("No se pudo reiniciar el detector de voz.", true));
      },
    };

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        fail("Este navegador no permite usar el micrófono.", false);
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        });
      } catch (err) {
        fail(micErrorMessage(err), false);
        return;
      }
      if (closed) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      try {
        const r = await startSession(projectId);
        sessionId = r.sessionId;
        conversationId = r.conversationId;
      } catch (err) {
        fail((err as Error).message, false);
        return;
      }
      if (closed) {
        void endSession(sessionId).catch(() => {});
        return;
      }
      lease.start();
      unsub = subscribe(onWs);
      window.addEventListener("keydown", onKey);
      window.addEventListener("pagehide", onPageHide);
      try {
        vad = await makeVad();
      } catch (err) {
        fail(`No se pudo cargar el detector de voz: ${(err as Error).message}`, true);
        return;
      }
      if (closed) {
        vad.destroy();
        vad = null;
        return;
      }
      dispatch({ type: "started" });
      idleTimer = setInterval(() => dispatch({ type: "idleTimeout" }), 5000);
      circleRef.current?.focus();
    })();

    return () => {
      api.current = null;
      if (closed) return;
      closed = true;
      if (sessionId) endSessionBeacon(sessionId);
      releaseResources();
    };
  }, []);

  const phase = conv.phase;
  const idleMin = Math.round(CONV_IDLE_MS / 60000);
  const active = phase === "speaking" || phase === "thinking";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Plática por voz"
      className="fixed inset-0 z-50 flex flex-col items-center bg-surface-0 px-4 py-6 overflow-y-auto"
    >
      <div className="flex w-full max-w-md flex-1 flex-col items-center gap-5">
        <h2 className="font-mono text-xs uppercase tracking-widest text-text-secondary">Platicar</h2>

        <button
          ref={circleRef}
          type="button"
          onClick={() => api.current?.interrupt()}
          disabled={phase === "ending" || phase === "ended" || phase === "error"}
          aria-label={active ? "Interrumpir al asistente" : PHASE_LABEL[phase]}
          title={active ? "Clic para interrumpir (también Esc o espacio)" : undefined}
          className={`mt-4 flex h-44 w-44 shrink-0 items-center justify-center rounded-full border-2 bg-surface-1 text-center font-mono text-sm transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent sm:h-52 sm:w-52 ${PHASE_STYLE[phase]}`}
        >
          {PHASE_LABEL[phase]}
        </button>

        <p role="status" aria-live="polite" className="sr-only">
          {PHASE_LABEL[phase]}
        </p>

        {phase === "error" ? (
          <div className="w-full text-center">
            <p role="alert" className="break-words font-mono text-xs text-err">{conv.error}</p>
            <button
              type="button"
              onClick={() => api.current?.dismiss()}
              className="mt-4 min-h-11 rounded-lg border border-edge-strong px-5 font-mono text-xs text-text-primary hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Cerrar
            </button>
          </div>
        ) : (
          <>
            <p className="text-center font-mono text-[11px] text-text-secondary">
              Esc o espacio para interrumpir · se cierra solo tras {idleMin} min sin voz
            </p>

            {notice && (
              <p role="alert" className="w-full break-words text-center font-mono text-[11px] text-err">{notice}</p>
            )}

            <ul className="w-full space-y-2" aria-label="Últimas frases">
              {lines.map((l) => (
                <li key={l.id} className="rounded-lg bg-surface-2/60 px-3 py-2 text-sm leading-relaxed text-text-primary">
                  <span className="mr-2 font-mono text-[10px] uppercase tracking-widest text-text-secondary">
                    {l.who === "tu" ? "tú" : "asistente"}
                  </span>
                  {l.text}
                </li>
              ))}
            </ul>

            <div className="mt-auto flex w-full flex-wrap items-center justify-between gap-3 pt-4">
              <button
                type="button"
                role="switch"
                aria-checked={bargeIn}
                aria-label="Interrumpir con la voz"
                title="Permite cortar al asistente hablándole; usa audífonos para evitar el eco"
                onClick={() => {
                  const next = !bargeIn;
                  setBargeIn(next);
                  bargeRef.current = next;
                  writeBargeIn(safeStorage(), next);
                  api.current?.rebuildVad();
                  // El espacio debe seguir interrumpiendo, no volver a alternar este interruptor.
                  circleRef.current?.focus();
                }}
                className={`min-h-11 rounded-lg px-3 font-mono text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${
                  bargeIn ? "text-accent" : "text-text-secondary hover:text-text-primary"
                }`}
              >
                interrumpir con la voz: {bargeIn ? "sí" : "no"}
              </button>
              <button
                type="button"
                onClick={() => api.current?.end()}
                disabled={phase === "ending" || phase === "starting"}
                aria-label="Terminar la plática"
                className="min-h-11 rounded-lg border border-edge-strong px-5 font-mono text-xs text-text-primary transition-colors hover:text-err focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
              >
                Terminar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
