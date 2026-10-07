import { MicVAD } from "@ricky0123/vad-web";

export { float32ToWav } from "./wav";

export type VadHandle = { start(): void; pause(): void; destroy(): void };

/** Detector de voz Silero (v5) en el navegador; assets locales en /vad/. */
export async function createVad(opts: {
  onSpeechStart: () => void;
  onSpeechEnd: (audio: Float32Array) => void;
  onMisfire?: () => void;
  stream: MediaStream;
  strict?: boolean;
}): Promise<VadHandle> {
  const positive = opts.strict ? 0.8 : 0.5;
  const vad = await MicVAD.new({
    model: "v5",
    baseAssetPath: "/vad/",
    onnxWASMBasePath: "/vad/",
    startOnLoad: false,
    getStream: async () => opts.stream,
    // No cerrar las pistas del llamador al pausar/reanudar.
    pauseStream: async () => {},
    resumeStream: async () => opts.stream,
    positiveSpeechThreshold: positive,
    negativeSpeechThreshold: positive - 0.15,
    // pause() entrega la frase en curso (onSpeechEnd): así se corta una frase de más de 60 s sin perder audio.
    submitUserSpeechOnPause: true,
    redemptionMs: 800,
    minSpeechMs: 300,
    onSpeechStart: opts.onSpeechStart,
    onSpeechEnd: opts.onSpeechEnd,
    onVADMisfire: opts.onMisfire ?? (() => {}),
  });
  return {
    start: () => void vad.start(),
    pause: () => void vad.pause(),
    destroy: () => void vad.destroy(),
  };
}
