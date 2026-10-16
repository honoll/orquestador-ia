// Topes y constantes del modo equipo (F14).
export const MAX_TAREAS = 30;
export const MAX_PROFUNDIDAD = 3; // la raíz (Jefe) es profundidad 0
export const MAX_TURNOS_TAREA = 8; // evita que dos agentes se comenten en bucle
export const PRESUPUESTO_META = 600_000; // tokens por meta si no se indica otro
export const TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
export const RESUMEN_HIJA_MAX = 1500;
export const COMENTARIO_MAX = 4000;
export const TITULO_MAX = 120;
export const INSTRUCCIONES_MAX = 8000;
export const PEDIDO_MAX = 4000;
export const CUERPO_MAX = 16 * 1024;
export const ESPERA_CUENTA_MS = 5 * 60 * 1000; // cuánto se espera la cuenta del turno anterior para retomar su sesión
export const COMENTARIOS_EN_PROMPT = 20;
export const JEFE_ROL = "jefe";
/** Fila de la barra para trabajo sin rol: ningún rol puede llamarse así. */
export const OTROS = "otros";
export const HUMANO = "humano";

/** URL de la API para los agentes (misma máquina: los trabajadores agy llegan por loopback). */
export const orqApi = (): string => `http://127.0.0.1:${process.env.ORQUESTADOR_PORT || "3110"}`;
