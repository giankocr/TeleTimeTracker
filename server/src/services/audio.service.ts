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

  try {
    const file = await toFile(params.buffer, params.filename ?? 'audio.ogg', {
      type: params.mimeType ?? 'audio/ogg',
    });
    const res = await ready.openai.audio.transcriptions.create({
      file,
      model: ready.model,
      language: params.language ?? 'es',
      prompt: TRANSCRIPTION_PROMPT,
    });
    return { text: (res.text ?? '').trim(), ok: true, provider: transcriptionProvider().provider, model: ready.model };
  } catch (err) {
    const detail =
      err instanceof OpenAI.APIError ? `${err.status} ${err.message}` : (err as Error).message;
    return {
      text: '',
      ok: false,
      provider: transcriptionProvider().provider,
      model: ready.model,
      error: `Transcripcion fallida (${transcriptionProvider().provider}): ${detail}`,
    };
  }
}
