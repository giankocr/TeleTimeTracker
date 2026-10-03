import { openaiKey } from '../config/env';
import { getSetting, SETTING_KEYS } from './settings.service';
import OpenAI, { toFile } from 'openai';

/**
 * Transcripcion de notas de voz (OpenAI Whisper).
 *
 * Se aisla en su propio modulo para poder sustituirlo en pruebas
 * (mock) o para cambiar de proveedor sin tocar el controlador del bot.
 */

export interface TranscriptionResult {
  text: string;
  ok: boolean;
  error?: string;
}

export async function transcribeAudio(params: {
  buffer: Buffer;
  filename?: string;
  mimeType?: string;
  language?: string;
}): Promise<TranscriptionResult> {
  const key = openaiKey();
  if (!key) {
    return { text: '', ok: false, error: 'OPENAI_API_KEY no configurada: no se pueden transcribir notas de voz.' };
  }
  try {
    const openai = new OpenAI({ apiKey: key });
    const file = await toFile(params.buffer, params.filename ?? 'audio.ogg', {
      type: params.mimeType ?? 'audio/ogg',
    });
    const res = await openai.audio.transcriptions.create({
      file,
      model: getSetting(SETTING_KEYS.WHISPER_MODEL, 'whisper-1'),
      language: params.language ?? 'es',
      prompt:
        'Nota de voz de un trabajador reportando la tarea en la que esta trabajando, el proyecto y el cliente.',
    });
    return { text: (res.text ?? '').trim(), ok: true };
  } catch (err) {
    return { text: '', ok: false, error: (err as Error).message };
  }
}

export const hasWhisper = (): boolean => Boolean(openaiKey());
