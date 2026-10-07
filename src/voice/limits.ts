/** Duración máxima aceptada para dictado, en segundos. */
export const MAX_AUDIO_SECONDS = 120;
/** WAV 16 kHz mono s16 de MAX_AUDIO_SECONDS (+ cabecera). */
export const MAX_WAV_BYTES = MAX_AUDIO_SECONDS * 16000 * 2 + 44;

export class AudioTooLongError extends Error {
  constructor() {
    super(`Audio demasiado largo (máx. ${MAX_AUDIO_SECONDS} s)`);
    this.name = "AudioTooLongError";
  }
}
