import { z } from 'zod';

export const zEmail = z.string().trim().toLowerCase().email('Correo electronico invalido').max(160);

/** Politica fuerte (altas y cambios de contrasena). */
export const zPassword = z
  .string()
  .min(8, 'La contrasena debe tener al menos 8 caracteres')
  .max(120, 'La contrasena es demasiado larga')
  .regex(/[A-Za-z]/, 'La contrasena debe incluir al menos una letra')
  .regex(/[0-9]/, 'La contrasena debe incluir al menos un numero');

/** Version laxa para payloads donde la validacion fuerte se hace aparte. */
export const zPasswordRelaxed = z.string().min(8).max(120);

export const zId = z.string().min(1).max(64);

export const zDateTime = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), 'Fecha invalida')
  .transform((v) => new Date(v));

export const zRangePreset = z.enum(['today', 'yesterday', 'last7', 'last30', 'thisMonth', 'lastMonth', 'custom']);

export const zPagination = z.object({
  take: z.coerce.number().int().min(1).max(500).optional(),
  skip: z.coerce.number().int().min(0).optional(),
});
