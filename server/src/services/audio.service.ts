import OpenAI, { toFile } from 'openai';
import { env, groqKey, openaiKey } from '../config/env';
import { getSetting, SETTING_KEYS } from './settings.service';

/**
 * Transcripcion de notas de voz.
 *
 * Dos proveedores con el MISMO SDK, porque Groq expone una API compatible
 * con la de OpenAI:
 *
 *   1. **Groq** (preferente si hay GROQ_API_KEY)
 *      endpoint https://api.groq.com/openai/v1 · modelo whisper-large-v3
 *   2. **OpenAI** (si hay OPENAI_API_KEY) · modelo whisper-1
 *
 * Esta aislado en su propio modulo para poder sustituirlo en pruebas (mock) o
 * cambiar de proveedor sin tocar el controlador del bot.
 */

export type TranscriptionProvider = 'groq' | 'openai' | 'none';

export interface ProviderInfo {
  provider: TranscriptionProvider;
  model: string | null;
  configured: boolean;
}

/** Proveedor efectivo segun las claves disponibles (Groq tiene prioridad). */
export function transcriptionProvider(): ProviderInfo {
  if (groqKey()) {
    return {
      provider: 'groq',
      model: getSetting(SETTING_KEYS.GROQ_WHISPER_MODEL, env.GROQ_WHISPER_MODEL),
      configured: true,
    };
  }
  if (openaiKey()) {
    return {
      provider: 'openai',
      model: getSetting(SETTING_KEYS.WHISPER_MODEL, env.WHISPER_MODEL),
      configured: true,
    };
  }
  return { provider: 'none', model: null, configured: false };
}

export const hasWhisper = (): boolean => transcriptionProvider().configured;

function provider(): { openai: OpenAI; model: string } | null {
  const info = transcriptionProvider();
  if (info.provider === 'groq') {
    return { openai: new OpenAI({ apiKey: groqKey(), baseURL: env.GROQ_BASE_URL }), model: info.model! };
  }
  if (info.provider === 'openai') {
    return { openai: new OpenAI({ apiKey: openaiKey() }), model: info.model! };
  }
  return null;
}

export interface TranscriptionResult {
  text: string;
  ok: boolean;
  error?: string;
  provider?: TranscriptionProvider;
  model?: string;
}

/** Prompt de contexto: sesga el reconocimiento hacia el vocabulario del dominio. */
const TRANSCRIPTION_PROMPT =
  'Nota de voz de un trabajador reportando la tarea en la que esta trabajando, el proyecto y el cliente. ' +
  'Vocabulario habitual: maquetacion, backend, despliegue, reunion, soporte, bugfix, sprint, repositorio, commits.';

/**
 * Formatos aceptados por Groq/OpenAI en la transcripcion.
 * Groq es estricto: rechaza el archivo si no reconoce el tipo.
 */
const ACCEPTED_EXTENSIONS = ['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'opus', 'wav', 'webm'] as const;

const MIME_BY_EXTENSION: Record<string, string> = {
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  mpeg: 'audio/mpeg',
  mpga: 'audio/mpeg',
  wav: 'audio/wav',
  webm: 'audio/webm',
  flac: 'audio/flac',
};

/**
 * Normaliza el audio recibido de Telegram para que el proveedor lo acepte.
 *
 * Telegram entrega las notas de voz como **Opus dentro de un contenedor OGG**
 * y con frecuencia con extension `.oga`, que no esta en la lista de formatos
 * aceptados. Aqui se decide un nombre de archivo y un tipo MIME validos:
 * sin esto Groq responde `400 file must be one of the following types: [...]`.
 */
export function resolveAudioFile(params: { filename?: string; mimeType?: string }): { filename: string; mimeType: string } {
  const rawExt = (params.filename ?? '').split('.').pop()?.toLowerCase() ?? '';
  const rawMime = (params.mimeType ?? '').toLowerCase().split(';')[0]!.trim();

  // 1) Si la extension ya es valida, se respeta.
  if ((ACCEPTED_EXTENSIONS as readonly string[]).includes(rawExt)) {
    return { filename: `audio.${rawExt}`, mimeType: MIME_BY_EXTENSION[rawExt] ?? (rawMime || 'audio/ogg') };
  }

  // 2) Extensiones de OGG que algunos proveedores no reconocen.
  if (['oga', 'ogg', 'opus', 'weba'].includes(rawExt)) {
    // `.oga` -> `.ogg` (mismo contenido, nombre aceptado por Groq).
    return { filename: 'audio.ogg', mimeType: 'audio/ogg' };
  }
  if (rawMime.includes('ogg') || rawMime.includes('opus')) {
    return { filename: 'audio.ogg', mimeType: 'audio/ogg' };
  }

  // 3) Si el MIME es reconocible, se usa ese formato.
  for (const [ext, mime] of Object.entries(MIME_BY_EXTENSION)) {
    if (rawMime === mime) return { filename: `audio.${ext}`, mimeType: mime };
  }

  // 4) Respaldo: las notas de voz de Telegram son OGG/Opus.
  return { filename: 'audio.ogg', mimeType: 'audio/ogg' };
}

export async function transcribeAudio(params: {
  buffer: Buffer;
  filename?: string;
  mimeType?: string;
  language?: string;
}): Promise<TranscriptionResult> {
  const ready = provider();
  if (!ready) {
    return {
      text: '',
      ok: false,
      provider: 'none',
      error:
        'No hay proveedor de transcripcion configurado. Define GROQ_API_KEY (recomendado) u OPENAI_API_KEY en el panel.',
    };
  }

  const file = resolveAudioFile({ filename: params.filename, mimeType: params.mimeType });

  try {
    const upload = await toFile(params.buffer, file.filename, { type: file.mimeType });
    const res = await ready.openai.audio.transcriptions.create({
      file: upload,
      model: ready.model,
      language: params.language ?? 'es',
      prompt: TRANSCRIPTION_PROMPT,
    });
    return {
      text: (res.text ?? '').trim(),
      ok: true,
      provider: transcriptionProvider().provider,
      model: ready.model,
    };
  } catch (err) {
    const detail =
      err instanceof OpenAI.APIError ? `${err.status} ${err.message}` : (err as Error).message;
    return {
      text: '',
      ok: false,
      provider: transcriptionProvider().provider,
      model: ready.model,
      error: `Transcripcion fallida (${transcriptionProvider().provider} · ${file.filename}): ${detail}`,
    };
  }
}
