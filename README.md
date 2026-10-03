# ⏱ TeleTimeTracker

Sistema híbrido de **control e historial de tiempo**: los trabajadores registran su jornada conversando con un **bot de Telegram** (notas de voz o texto), y la administración gestiona todo desde un **panel web** con gráficos, usuarios, roles y reportes.

Todo el sistema se empaqueta en **un solo contenedor Docker** listo para desplegar en **EasyPanel** con un clic.

---

## 🧱 1. Arquitectura y estructura del proyecto

```
teletimetracker/
├── Dockerfile                  # Build multi-etapa: deps -> build -> runtime (node:20-alpine)
├── docker-compose.yml          # 1 contenedor + volumen persistente (ttt_data)
├── .env.example                # Todas las variables de entorno documentadas
├── package.json                # Monorepo (npm workspaces: server + web)
├── tsconfig.json               # Base TypeScript
├── tsconfig.server.json        # Compila backend -> dist/
│
├── shared/
│   └── types.ts                # Contratos compartidos: permisos, intents del bot, DTOs
│
├── server/                     # BACKEND (Fastify + Prisma)
│   ├── prisma/
│   │   ├── schema.prisma       # Esquema de BD (SQLite o PostgreSQL)
│   │   ├── migrations/         # Migraciones versionadas (se aplican al arrancar)
│   │   └── seed.ts             # Roles, admin inicial, tipos de tarea, datos demo
│   └── src/
│       ├── index.ts            # Arranque: migrate + seed + API + panel + bot + alertas
│       ├── app.ts              # Fastify: CORS, JWT, cookies, estáticos (SPA), errores
│       ├── config/
│       │   ├── env.ts          # Variables de entorno tipadas + resolución de DATABASE_URL
│       │   ├── crypto.ts       # AES-256-GCM para secretos + tokens/códigos
│       │   └── bootstrap.ts    # Migraciones y seed automáticos (proceso hijo)
│       ├── db/prisma.ts        # Cliente Prisma único + PRAGMA de SQLite
│       ├── middleware/auth.ts  # JWT, sesiones revocables, RBAC (permisos y alcance)
│       ├── utils/              # time (zonas horarias), format, audit, validators
│       ├── routes/
│       │   ├── auth.routes.ts      # login, refresh, logout, perfil, cambio de clave
│       │   ├── users.routes.ts      # CRUD usuarios, roles, reset de clave, Telegram
│       │   ├── roles.routes.ts      # CRUD roles/permisos (RBAC)
│       │   ├── clients.routes.ts    # clientes, proyectos, tipos de tarea, pendientes
│       │   ├── entries.routes.ts    # registros: filtros, manual, start/pause/stop
│       │   ├── reports.routes.ts    # dashboard, ranking de equipo, export CSV
│       │   ├── settings.routes.ts   # tokens, jornada, webhook, auditoría, trazabilidad
│       │   └── telegram.routes.ts   # webhook de Telegram + diagnóstico + simulador
│       ├── services/
│       │   ├── timer.service.ts     # ⭐ máquina de estados del cronómetro
│       │   ├── nlu.service.ts       # NLU: intents y entidades (OpenAI o heurística)
│       │   ├── audio.service.ts     # Transcripción Whisper de notas de voz
│       │   ├── resolve.service.ts   # Resolución difusa de proyecto/cliente/tipo
│       │   ├── report.service.ts    # Agregaciones de horas (con duración "viva")
│       │   ├── github.service.ts    # Commits y PRs de la ventana trabajada
│       │   ├── alerts.service.ts    # Cron: inactividad, digest diario, limpieza
│       │   ├── settings.service.ts  # Config dinámica (BD + entorno, secretos cifrados)
│       │   ├── assistant.service.ts # Contexto del bot, reportes y pendientes
│       │   ├── entries.service.ts   # Serialización de registros
│       │   └── auth.service.ts      # Emisión/rotación de tokens, sesiones
│       └── bot/
│           ├── telegram.api.ts      # Cliente HTTP de la Bot API (sin dependencias)
│           ├── telegram.controller.ts # Orquestador: comandos, voz, botones, polling
│           └── messages.ts          # Plantillas de respuesta y teclados
│
└── web/                        # FRONTEND (Vite + React + Recharts)
    ├── index.html
    ├── vite.config.ts
    └── src/
        ├── main.tsx / App.tsx    # Rutas y guards de sesión/permisos
        ├── styles.css            # Diseño oscuro minimalista y responsivo
        ├── lib/                  # cliente HTTP con refresh, contexto de auth, formato
        ├── components/           # Layout (sidebar + cronómetro en vivo), UI base
        └── pages/                # Login, Dashboard, Registros, Reportes, Pendientes,
                                  # Clientes, Proyectos, Usuarios, Roles, Configuración,
                                  # Perfil, Vincular Telegram
```

### Flujo de datos

```
Trabajador                       Sistema                        Administración
   │                                │                                │
   │  🎙 nota de voz / 💬 texto     │                                │
   ├──────────────► Bot Telegram ───┤                                │
   │                    │           │                                │
   │              Whisper (voz)     │                                │
   │                    ▼           │                                │
   │            NLU (intent+entidades)                               │
   │                    ▼           │                                │
   │        timer.service (estado)  │──── Panel Web (JWT + RBAC) ────┤
   │                    ▼           │           │                    │
   │            SQLite (volumen)    │      reportes y gráficos       │
   │                    ▼           │                                │
   │  ◄── confirmación + GitHub ────┤                                │
```

---

## 🗄️ 2. Esquema de base de datos

SQLite por defecto (archivo en `/app/data`), con opción de PostgreSQL cambiando el `provider` en `server/prisma/schema.prisma`.

### Usuarios, roles y permisos (RBAC)

| Modelo | Campos clave | Notas |
|---|---|---|
| **Role** | `key` (`ADMIN`/`MANAGER`/`USER`), `name`, `permissions` (lista separada por comas), `isSystem` | `*` = acceso total. Los roles de sistema no se pueden borrar. |
| **User** | `email`, `passwordHash` (bcrypt), `fullName`, `roleId`, `managerId`, `isActive` | `managerId` define la jerarquía para los reportes de equipo. |
| **User** (Telegram) | `telegramId`, `telegramUsername`, `telegramLinkedAt`, `telegramLinkCode`, `telegramLinkExp` | Código efímero tipo `ABCD-1234` para vincular la cuenta. |
| **User** (GitHub) | `githubUsername`, `githubToken` | El token se guarda **cifrado** (AES-256-GCM). |
| **User** (jornada) | `workDays`, `workStart`, `workEnd`, `timezone`, `idleAlertMin`, `dailyDigest` | Controla cuándo el bot puede enviar alertas. |
| **User** (teléfono/OTP) | `phone` (único, E.164), `phoneVerifiedAt`, `otpCodeHash`, `otpExpiresAt`, `otpAttempts`, `otpLastSentAt` | Habilita el acceso «Teléfono + código»; el OTP se guarda hasheado. |
| **AuthSession** | `refreshHash`, `expiresAt`, `revokedAt` | Permite revocar sesiones (logout, cambio de clave, desactivación). |

**Permisos disponibles** (`shared/types.ts`): `users:*`, `roles:*`, `clients:*`, `projects:*`, `tasktypes:*`, `entries:read:own`, `entries:read:all`, `entries:write`, `entries:delete`, `reports:own|team|all`, `settings:read|write`, `audit:read`, `bot:admin`.

**Roles predefinidos**
- **ADMIN** → `*` (acceso total).
- **MANAGER** → gestiona clientes/proyectos y ve los reportes de su equipo (`reports:team`).
- **USER** → registra su tiempo y consulta su propio historial (`reports:own`).

### Clientes, proyectos y tipos de tarea

| Modelo | Campos clave |
|---|---|
| **Client** | `name`, `code` (ayuda al bot a reconocerlo por voz), `notes`, `isActive` |
| **ClientProject** | `clientId`, `name`, `githubRepos` (`owner/repo`, varios por coma), `budgetHours`, `hourlyRate`, `isActive` |
| **ProjectMember** | `projectId` + `userId` + `role` (`OWNER`/`MEMBER`/`VIEWER`) |
| **TaskType** | `name`, `aliases` (para el NLU), `color`, `billable` |
| **PendingTask** | `userId`, `title`, `priority`, `dueDate`, `isDone` → alimenta la alerta diaria |

### Tiempos (núcleo del sistema)

`TimeEntry` representa **un segmento trabajado** ("lap") sobre un proyecto:

| Campo | Descripción |
|---|---|
| `userId`, `projectId`, `clientId`, `taskTypeId` | Relaciones del segmento |
| `title`, `description` | Texto original (limpio) y detalle de lo realizado |
| `startedAt`, `endedAt` | Ventana del segmento |
| `durationSec` | Segundos trabajados **excluyendo pausas** |
| `status` | `RUNNING` · `PAUSED` · `FINISHED` · `CANCELLED` |
| `source` | `TELEGRAM_VOICE` · `TELEGRAM_TEXT` · `TELEGRAM_BUTTON` · `WEB` · `API` |
| `closeReason` | `SWITCH` · `FINISH` · `PAUSE` · `IDLE_TIMEOUT` · `MANUAL_WEB` |
| `githubData` | JSON con commits/PRs de la ventana + `githubSyncedAt` |
| `billable`, `editedById` | Facturación y auditoría de correcciones |

Tablas de apoyo: **Pause** (pausas con motivo y duración), **EntryTag** (etiquetas), **AlertLog** (anti-spam de alertas), **AuditLog** (acciones del panel), **BotMessage** (trazabilidad del NLU), **SystemSetting** (config cifrada), **BotContact** (solicitudes de acceso enviadas desde el bot).

**Reglas de negocio garantizadas por `timer.service.ts`:**
1. Un usuario solo puede tener **un segmento activo** (`RUNNING` o `PAUSED`) a la vez.
2. `start` cierra el segmento anterior con `closeReason=SWITCH` y abre uno nuevo.
3. `pause` detiene el reloj y abre una fila en `Pause`; `resume` la cierra.
4. `stop` calcula `durationSec` descontando pausas y adjunta commits/PRs de GitHub.
5. Un cron nocturno cierra segmentos olvidados (>16 h) con `closeReason=IDLE_TIMEOUT`.

---

## 🤖 3. El bot de Telegram

### Comandos

| Comando | Función |
|---|---|
| `/vincular CODIGO` | Vincula el chat con la cuenta del panel |
| `/estado` | Tarea actual, tiempo transcurrido y total del día |
| `/reporte [hoy\|ayer\|semana\|mes]` | Resumen de horas del periodo |
| `/pendientes` | Lista de tareas pendientes (backlog) |
| `/pausar`, `/retomar`, `/terminar`, `/cancelar` | Control del cronómetro |
| `/tiempo TAREA` | **Tiempo consumido** en una tarea o proyecto (`/tiempo login`, `/tiempo Portal Web`) |
| `/misproyectos`, `/ayuda` | Proyectos disponibles y ayuda |

También hay un **teclado persistente** (Estado · Pendientes · Pausar · Retomar · Terminar) y **botones inline** en cada confirmación.

### Lenguaje natural (voz o texto)

Ejemplos reales que el sistema entiende:

| El trabajador dice… | Intent | Resultado |
|---|---|---|
| "Iniciando tarea de maquetación del login en el proyecto Portal Web del cliente Acme" | `START` | Abre segmento · título "maquetacion del login" · tipo `Maquetacion` |
| "Pausa para reunión de equipo" | `PAUSE` | Detiene el reloj guardando el motivo |
| "Retomo la tarea" | `RESUME` | Reanuda el mismo segmento |
| "Cambia a la tarea de soporte del cliente Acme" | `SWITCH` | Cierra el anterior y abre el nuevo |
| "Terminé la tarea, ajusté el login y subí el fix" | `STOP` | Cierra y adjunta commits/PRs de GitHub |
| "Reporte de hoy" / "¿Cuántas horas hice ayer?" | `REPORT` | Resumen de horas |
| "¿Qué tengo pendiente?" | `AGENDA` | Backlog + tarea en curso |

**Formatos de audio aceptados** — Groq es estricto: el archivo debe llegar con un `Content-Type` reconocible. Telegram entrega las notas de voz como **Opus en contenedor OGG** y a menudo con extensión `.oga`, que no está en la lista aceptada (`flac mp3 mp4 mpeg mpga m4a ogg opus wav webm`). Además el SDK **no deduce el MIME del nombre del archivo**: si no se le pasa un tipo explícito, el `Content-Type` de la parte multipart queda vacío y Groq responde `400 file must be one of the following types`. Por eso `resolveAudioFile()` normaliza nombre y MIME antes de subir el audio (`.oga` → `audio.ogg` / `audio/ogg`).

**Proveedores de IA** — se elige solo, con el **mismo SDK** porque la API de Groq es compatible con la de OpenAI:

| Proveedor | Transcripción | Interpretación (NLU) | Cuándo se usa |
|---|---|---|---|
| **Groq** (recomendado) | `whisper-large-v3` | `llama-3.1-8b-instant` | Si defines `GROQ_API_KEY`. Más rápido y barato |
| **OpenAI** | `whisper-1` | `gpt-4o-mini` | Si defines `OPENAI_API_KEY` y no hay clave de Groq |
| **Heurístico** (sin clave) | ✗ no transcribe | reglas y palabras clave | Siempre como respaldo: el bot funciona por texto |

Con Groq se configuran `GROQ_WHISPER_MODEL` y `GROQ_LLM_MODEL` (editables desde el panel). En *Configuración → Probar claves de IA* se valida la clave contra la API y se listan los modelos disponibles, que es la forma más rápida de detectar una clave incompleta o un modelo retirado.

Los nombres se resuelven con **matching difuso** (normalización + Levenshtein) contra los proyectos/clientes visibles para el usuario; si hay ambigüedad, el bot muestra botones para elegir.

### ¿De dónde sale `TELEGRAM_WEBHOOK_SECRET`?

**No lo da Telegram ni BotFather: lo generas tú.** Es una cadena aleatoria que solo se usa para comprobar que quien llama a `POST /api/telegram/webhook` es realmente Telegram y no un tercero.

```bash
openssl rand -hex 32      # p. ej. 9f2c7ab41d5e8036…c1a4e77b
```

Se usa en dos sitios y debe coincidir:

1. Se guarda en *Configuración → Telegram* (o en la variable de entorno `TELEGRAM_WEBHOOK_SECRET`).
2. Se registra con el webhook: el backend lo envía a Telegram en `setWebhook`, y Telegram lo devuelve en cada petición en la cabecera `X-Telegram-Bot-Api-Secret-Token`. Si no coincide, el webhook responde `401`.

Si lo dejas vacío, el webhook acepta cualquier petición firmada: funciona, pero cualquiera que descubra la URL podría inyectar mensajes falsos. En producción, defínelo siempre.

**Cómo se comporta el panel con los secretos** (esto explica el texto «valor enmascarado (sin cambios)» que aparece en los campos):

- Si el campo muestra algo como `1234••••••••abcd`, hay un valor guardado. **No lo toques y se conserva**; el panel nunca devuelve el secreto completo.
- Si escribes un valor nuevo, se reemplaza (se guarda cifrado con AES-256-GCM).
- Si **borras el campo y guardas**, se elimina el valor guardado y el sistema vuelve a usar el de la variable de entorno (`.env`). Es la forma de deshacer un valor equivocado.

### Login con Telegram: usa el flujo OIDC (`telegram.login_mode = oidc`)

Telegram **archivó el widget iframe antiguo** (`telegram-widget.js` con HMAC del bot token y `/setdomain`) y la redirección `oauth.telegram.org/auth` sin OIDC. Lo vigente es la **Login library + OpenID Connect**: ver [core.telegram.org/bots/telegram-login](https://core.telegram.org/bots/telegram-login).

| Modo | Estado | Qué usa |
|---|---|---|
| **`oidc`** (por defecto) | ✅ Vigente | Librería `telegram-login.js` (popup) → `id_token` JWT firmado con **RS256**, verificado contra el **JWKS** de Telegram |
| `oauth` | ⚠️ En desuso | Redirección a `oauth.telegram.org/auth` con `bot_id` |
| `widget` | ⚠️ En desuso | Widget iframe legacy (HMAC-SHA256 del bot token + `/setdomain`) |

**Configuración (una sola vez):**

1. Abre **@BotFather** → `/mybots` → tu bot → **Login Widget**.
2. Añade estas **Allowed URLs** (las dos, para no depender de la ruta):

   ```
   https://tu-dominio.com
   https://tu-dominio.com/login
   ```

   > ⚠️ **La segunda es obligatoria.** La librería oficial calcula el `redirect_uri` como
   > `location.origin + location.pathname` (ver `openPopup` en `telegram-login.js`), y la
   > pantalla de acceso vive en `/login`. Si esa URL exacta no está registrada, Telegram
   > responde **`redirect_uri required`** y el popup ni siquiera se abre. En local añade
   > también `http://localhost:8080` y `http://localhost:8080/login`.

3. Copia el **Client ID** y el **Client Secret** que muestra BotFather y pégalos en *Configuración → Telegram* (`telegram.login_client_id` y `telegram.login_client_secret`). El panel muestra el Client ID que está usando y te avisa si es solo el respaldo extraído del token del bot.
4. Asegúrate de que el panel se sirve por **HTTPS**.
5. Cada usuario debe haber vinculado su cuenta: abre el bot, `/start` y **📱 Compartir mi número**.

**Errores típicos y su causa**

| Mensaje de Telegram | Causa | Solución |
|---|---|---|
| `redirect_uri required` | La URL donde está el botón no está en la lista blanca | Registrar `https://tu-dominio.com/login` en **Allowed URLs** |
| `client_id invalid` / el popup no abre | El Client ID no es el de BotFather (se está usando el respaldo del token) | Pegar el **Client ID** real en Configuración |
| El botón no aparece | Falta el token del bot o el Client ID | Revisar *Configuración → Telegram* |
| El login se queda «cargando» y no vuelve | Falta `Cross-Origin-Opener-Policy: same-origin-allow-popups` o el navegador bloquea popups | Ya se envía desde el servidor; permite popups para el dominio |

**Cómo se valida el `id_token`** (`server/src/services/telegram-oidc.service.ts`):

1. Se descarga y cachea el **JWKS** (`https://oauth.telegram.org/.well-known/jwks.json`, 10 min de TTL) y se localiza la clave por `kid` (con refresco automático si rotó).
2. Se verifica la **firma RS256** con `jsonwebtoken` y se comprueban `iss` (`https://oauth.telegram.org`), `aud` (tu **Client ID**) y `exp`, con 60 s de tolerancia de reloj.
3. Se rechazan `alg: none` y algoritmos distintos de RS256; se admite `nonce` para evitar replay.
4. Se busca el usuario por el claim `id` (id de Telegram) y se exige cuenta **vinculada y activa**.
5. Si el usuario autorizó el scope `phone`, el `phone_number` del token se guarda normalizado en su perfil.

**Detalle crítico de implementación:** la librería de Telegram completa el login comunicándose con una **ventana popup**. Si el panel enviara `Cross-Origin-Opener-Policy: same-origin`, esa comunicación se bloquearía y el login fallaría; por eso el servidor envía `same-origin-allow-popups` (ver `server/src/app.ts`).

**Flujo manual OIDC (opcional):** también está implementado el Authorization Code Flow con **PKCE S256** (`createPkce`, `buildAuthorizationUrl`, `exchangeCodeForTokens`), útil si prefieres un broker OIDC o un cliente nativo. En ese caso el `Client Secret` se usa solo en el servidor (Basic Auth contra `/token`) y nunca se expone al navegador.

### Acceso al panel con Telegram (tres vías)### Acceso al panel con Telegram (tres vías)

Igual que en NosotrosConstruimos, la pantalla de login ofrece **tres formas de entrar**:

| Vía | Cuándo usarla | Cómo funciona |
|---|---|---|
| **Telegram** (un clic) | Uso diario de la mayoría | Telegram OAuth: se abre `oauth.telegram.org/auth` con el `bot_id` público; Telegram devuelve al usuario a `/login/telegram/callback` con los datos firmados en el hash (`#tgAuthResult`), que el navegador reenvía a `POST /api/auth/telegram/oauth` |
| **Teléfono + código** | Cuando el OAuth no sirve: navegador interno de Telegram, sin botón, etc. | `POST /api/auth/phone/request` envía un código de 6 dígitos **por el chat del bot**; `POST /api/auth/phone/verify` valida y abre sesión |
| **Correo + contraseña** | Administradores y supervisores | Login clásico con bcrypt + JWT |

**Cómo empezar a usarlas**

1. Guarda el **token del bot** en *Configuración* (se aplica en caliente).
2. Cada persona **vincula su Telegram**: abre el bot, toca `/start` y pulsa **📱 Compartir mi número** (botón persistente del teclado; también vale el código de vinculación `/vincular ABCD-1234`).
   - Si su teléfono ya está registrado por un administrador → queda vinculado al instante.
   - Si no existe → el bot crea una **solicitud de acceso** que aparece en *Usuarios → Solicitudes de acceso desde el bot*, donde el admin la aprueba con un clic (crea la cuenta, asigna rol y vincula el Telegram) o la rechaza.
3. Asegura que el **teléfono** esté registrado en cada usuario (columna «Teléfono» en *Usuarios*) para el acceso con código. Se normaliza a E.164 (sin prefijo se asume Colombia `+57`).
4. En producción el panel debe servirse por **HTTPS** para que Telegram acepte el retorno.

> No hace falta configurar `/setdomain` en BotFather con este flujo: el botón usa la autorización oficial de Telegram y el servidor valida el `origin` contra la firma.

**Seguridad**

- El servidor recomputa la firma **HMAC-SHA256** con `SHA256(bot_token)`, la compara en **tiempo constante** y **rechaza autorizaciones de más de 1 hora**.
- El hash nunca se interpreta en el cliente para decidir el acceso: el navegador solo lo reenvía; la única implementación de la verdad vive en `server/src/services/telegram-auth.service.ts`.
- Los **códigos OTP** duran 10 minutos, son de **un solo uso**, admiten **5 intentos**, tienen **anti-spam de 60 s** entre envíos y se guardan como **SHA-256** (nunca en claro).
- Solo se acepta un contacto **propio** (`contact.user_id === from.id`): Telegram permite reenviar la agenda de otra persona.
- Todo intento (acertado o fallido) queda en `audit_logs`; los OTP se auditan enmascarados (`+573001•••567`).

### Alta guiada: crear cliente y proyecto sin salir del chat

Si el trabajador empieza una tarea y el **cliente o el proyecto no existen**, el bot no se limita a rechazarlo: le acompaña para crearlos y **arranca el cronómetro con lo que ya había dicho**. Todo lo que el usuario mencionó (proyecto, cliente, tipo de tarea y título) se conserva para no volver a preguntarlo.

```
Trabajador: Iniciando tarea de maquetación del login para el cliente Acme Corp

Bot: 📁 Todavía no hay proyectos ni clientes.
     ¿Cómo se llama el cliente?            ← o lista de proyectos + «➕ Crear proyecto nuevo»

Trabajador: Acme Corp

Bot: ✅ Cliente Acme Corp creado.
     ¿Cómo se llama el proyecto?

Trabajador: Portal Web

Bot: ✅ Proyecto Portal Web creado en Acme Corp.
     ▶️ Tarea iniciada
     🟢 maquetacion del login · Portal Web · Acme Corp · Maquetación
```

Detalles del comportamiento:

- Si el cliente **ya existe** no se duplica: se reutiliza (y se reactiva si estaba desactivado), igual que el proyecto.
- El creador queda como **miembro** del proyecto para que lo vea en sus próximos mensajes.
- Si el usuario se equivoca con el proyecto pero ya tiene otros, el bot le ofrece la **lista con botones** (`➕ Crear proyecto nuevo` / `➕ Crear cliente y proyecto`).
- El flujo se puede **cancelar** escribiendo `cancelar`. Caduca a los 15 minutos.
- Los datos que se crean son reales: aparecen en el panel web (Clientes / Proyectos) y el administrador puede completarlos después (presupuesto, tarifas, repos de GitHub).
- La respuesta a «¿en qué vas a trabajar?» se distingue de una tarea nueva mientras el flujo está activo, así que el usuario solo escribe el nombre.

**Tiempo consumido:** `humanDuration` muestra segundos, minutos u horas según corresponda (`45s`, `1m 30s`, `2h`), y `/tiempo <texto>` suma **todos** los registros que coincidan con ese texto (por título, descripción, proyecto o cliente), agrupados por proyecto y con los últimos registros. `/estado` añade además el acumulado del proyecto de la tarea en curso. Las tareas nuevas reconocen el proyecto ya creado sin volver a preguntar.

### Alertas proactivas
- **Inactividad**: dentro de la jornada, si no hay tarea corriendo (o una pausa dura demasiado) avisa por Telegram. Máximo 1 aviso por hora por usuario.
- **Digest diario** (cron configurable, por defecto 08:00 L-V): horas del día anterior, desglose por proyecto y pendientes.

### Integración con GitHub
Al cerrar una tarea, si el proyecto tiene `githubRepos`, se consultan **commits y PRs** dentro de la ventana trabajada y se adjuntan al reporte final (`githubData`). El token puede ser global (configuración) o personal (perfil de cada usuario).

---

## 🖥️ 4. Panel web

| Pantalla | Qué hace |
|---|---|
| **Login** | Tres vías: **Telegram (un clic)**, **Teléfono + código por el bot** y **Correo + contraseña**, con JWT y refresh rotativo |
| **Dashboard** | Totales, facturables, promedio por persona, gráficos por día/cliente/tipo, "ahora mismo" con cronómetros vivos |
| **Registros** | Historial filtrable (rango, estado, cliente, proyecto, persona), cronómetro propio con pausar/reanudar/finalizar, registro manual y export CSV |
| **Reportes** | Ranking del equipo, horas por cliente/proyecto/tipo, export CSV |
| **Pendientes** | Backlog personal que alimenta el digest del bot |
| **Clientes / Proyectos** | CRUD, repos de GitHub, presupuesto y tarifa, equipo asignado, tipos de tarea |
| **Usuarios** | CRUD, rol, supervisor, jornada, Telegram (vincular/desvincular/código), reset de contraseña |
| **Roles** | Editor de permisos agrupados por área, con plantillas |
| **Configuración** | Tokens (Telegram/OpenAI/GitHub), jornada por defecto, alertas, registro de webhook, simulador del NLU, auditoría y trazabilidad del bot |
| **Perfil / Vincular Telegram** | Datos propios, jornada, GitHub, cambio de contraseña, código de vinculación |

RBAC en la UI: el menú y los guards de ruta se construyen a partir de los permisos del rol, y el backend vuelve a validar cada petición (los permisos se leen de la BD en cada request, no del token).

---

## 🚀 5. Guía rápida de despliegue en EasyPanel

### 5.1 Crear la aplicación

1. En EasyPanel: **Create → App** (o **Compose** si prefieres usar `docker-compose.yml`).
2. **Source**: conecta tu repositorio Git (o sube el proyecto).
3. **Build**: método **Dockerfile**, ruta `./Dockerfile`.
4. **Port**: `8080` (el contenedor expone ese puerto; EasyPanel asigna el dominio).
5. **Domain**: añade tu dominio, p. ej. `https://tiempo.tudominio.com`, con HTTPS activado.

### 5.2 Volumen persistente (⚠️ imprescindible)

| Ajuste | Valor |
|---|---|
| **Mount path** | `/app/data` |
| **Volume name** | `teletimetracker-data` (o el que prefieras) |

> Ahí vive `teletimetracker.db` (SQLite). **Es lo único que hay que respaldar.** Si no montas el volumen, perderás todos los registros en cada redeploy.

Si eliges **PostgreSQL** en lugar de SQLite, crea un servicio Postgres en EasyPanel y define `DATABASE_URL` (ver 5.4); en ese caso el volumen solo guarda datos auxiliares.

### 5.3 Variables de entorno

Pega las variables de `.env.example` en la pestaña **Environment** del servicio. Genera los secretos con:

```bash
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # SETTINGS_ENC_KEY
openssl rand -hex 16   # TELEGRAM_WEBHOOK_SECRET
```

Mínimo imprescindible:

```env
NODE_ENV=production
DATA_DIR=/app/data          # ← imprescindible: debe coincidir con el Mount Path del volumen
TELEGRAM_MODE=polling       # ← recomendado en el primer despliegue (no necesita dominio)
JWT_SECRET=<openssl rand -hex 32>
SETTINGS_ENC_KEY=<openssl rand -hex 32>

ADMIN_EMAIL=admin@tudominio.com
ADMIN_PASSWORD=<clave-fuerte>
ADMIN_NAME=Administrador

PUBLIC_URL=https://tiempo.tudominio.com     # tu dominio de EasyPanel, SIN barra final
TELEGRAM_BOT_TOKEN=<token de @BotFather>
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_SECRET=<openssl rand -hex 16>

OPENAI_API_KEY=<sk-...>                      # para transcribir notas de voz
DEFAULT_TIMEZONE=America/Bogota
```

### 5.4 Base de datos: SQLite (por defecto) o MySQL

El motor se detecta **por la forma de `DATABASE_URL`**: no hay que cambiar el `provider` del esquema ni reconstruir nada.

| `DATABASE_URL` | Motor | Migraciones aplicadas |
|---|---|---|
| vacío o `file:/app/data/teletimetracker.db` | SQLite | `server/prisma/migrations` |
| `mysql://…` | MySQL | `server/prisma/migrations.mysql` |

**SQLite** (recomendado para 1 sola instancia): no definas `DATABASE_URL`. La base vive en el volumen `/app/data`.

**MySQL** (si ya tienes el servicio):

```env
DATABASE_URL=mysql://USUARIO:PASSWORD@HOST:3306/NOMBRE_DB
```

- Dentro de EasyPanel, `HOST` es el **nombre del servicio** (p. ej. `mysql` o el que le pusiste), no la IP pública.
- **Percent-encodea el password** si lleva caracteres especiales: `!`→`%21`, `@`→`%40`, `#`→`%23`, `$`→`%24`, `%`→`%25`, `:`→`%3A`, `/`→`%2F`. Sin esto la URL se parsea mal.
- En el primer arranque se crean las 17 tablas y se siembra solo (roles, admin, tipos de tarea).

**Qué pasa al arrancar con MySQL** (todo automático, sin tocar el Dockerfile):

1. Detecta el motor por `DATABASE_URL`.
2. Si el cliente de Prisma generado en la imagen no corresponde (la imagen se compila con SQLite), usa el cliente de MySQL que ya viene empaquetado en `/prisma-client-mysql`, o lo regenera con el CLI si no existe.
3. Aplica las migraciones de `server/prisma/migrations.mysql` con el aplicador propio del arranque, registrándolas en la tabla `_app_migrations`.
4. Si la base **ya tenía tablas** (por ejemplo, una migración desde SQLite o un `db push` anterior) las migraciones se registran como aplicadas **sin re-ejecutarlas**, así que no rompe una base existente.
5. Ejecuta el seed (roles, admin, tipos de tarea) y levanta el panel.

> ¿Por qué hay un aplicador propio y no `prisma migrate deploy`? Prisma busca **siempre** el directorio `migrations/` junto al esquema y compara su `migration_lock.toml` con el provider del esquema: al convivir los juegos de SQLite y MySQL, `migrate deploy` falla con `P3019` (*datasource provider `mysql` does not match the one specified in the migration_lock.toml, `sqlite`*). El aplicador (`server/src/db/migrator.ts`) ejecuta el mismo SQL y mantiene el historial en `_app_migrations`. Para desarrollo local con SQLite, `prisma migrate dev` sigue funcionando normalmente.

**Requisito del usuario de MySQL:** debe usar el plugin **`caching_sha2_password`** (el estándar de MySQL 8). Con `sha256_password` Prisma falla con `Unknown authentication plugin 'sha256_password'`. Para corregirlo:

```sql
ALTER USER 'tu_usuario'@'%' IDENTIFIED WITH caching_sha2_password BY 'tu_password';
FLUSH PRIVILEGES;
```

> ⚠️ **PostgreSQL no está soportado de serie**: el SQL de las migraciones es específico del motor y solo se incluyen los juegos de SQLite y MySQL.

#### Por qué hay un esquema aparte para MySQL

El esquema base usa `provider = "sqlite"`, donde Prisma asigna `TEXT` (sin límite) a los campos `String`. En MySQL el valor por defecto es `VARCHAR(191)`, que **truncaría** campos que el sistema escribe más largos (transcripciones del NLU, descripciones de hasta 4000 caracteres…). Además MySQL no acepta tipos nativos con `provider = "sqlite"`.

Por eso hay **un solo origen de verdad** (`server/prisma/schema.prisma`) y un generador que deriva el de MySQL:

```bash
node scripts/generate-mysql-schema.mjs          # crea server/prisma/schema.mysql.prisma
node scripts/generate-mysql-schema.mjs --check  # falla si está desincronizado
```

El generador añade 83 anotaciones `@db.*` (por ejemplo `description String? @db.Text` y `permissions String @db.VarChar(600)`). Nota: los campos con `DEFAULT ''` **no pueden ser `TEXT`** en MySQL (error 1101), por eso `permissions` y `aliases` usan `VarChar` holgado.

### 5.5 Configurar el bot de Telegram

1. Habla con **@BotFather** → `/newbot` → obtén el token → ponlo en `TELEGRAM_BOT_TOKEN`.
2. Espera a que el contenedor arranque (verás `🤖 Bot conectado: @tu_bot` en los logs).
3. **El webhook se registra solo** al arrancar si `PUBLIC_URL` está definido. También puedes hacerlo desde **Configuración → Registrar webhook** y comprobar el estado con **Probar token**.
4. En Telegram, envía `/start` al bot. Cada trabajador vincula su cuenta así:
   - En el panel: **Vincular Telegram → Generar código** (o el admin lo genera desde **Usuarios → 🔗**).
   - En el bot: `/vincular ABCD-1234`.

> **Sin dominio público**: usa `TELEGRAM_MODE=polling` para que el bot consulte a Telegram (long polling) sin necesidad de webhook.

### 5.6 Primer acceso

1. Abre `https://tu-dominio` → entra con `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
2. **Cambia la contraseña** en *Mi perfil* (el seed avisa si usas la de por defecto).
3. Crea clientes → proyectos (con repos de GitHub) → usuarios y asígnales rol y supervisor.
4. Cada trabajador vincula su Telegram y ya puede enviar notas de voz.
5. Para habilitar el **acceso con Telegram y con Teléfono + código**: guarda el token del bot en Configuración y pide a cada persona que comparta su número con el bot (ver la sección de acceso al panel). Registra también su teléfono en *Usuarios* si quieres que puedan entrar con código.

### 5.7 Si no levanta: diagnóstico paso a paso

El contenedor ya no muere en silencio: **abre el puerto primero** y registra el motivo. Mira los **Logs** del servicio en EasyPanel y localiza la línea que empieza por `❌`, `⚠` o `ℹ`. Estas son las causas por orden de frecuencia:

#### 1) El volumen no está montado o no es escribible  ← la más común

En los logs verás:

```
❌ El directorio de datos no es escribible: /app/data
   Causa: EPERM
```

**Solución exacta en EasyPanel** → pestaña **Mounts** del servicio:

| Campo | Valor |
|---|---|
| Type | `Volume` |
| Name | `teletimetracker-data` |
| **Mount Path** | **`/app/data`** ← exacto, sin barra final |

Y en **Environment** debe existir `DATA_DIR=/app/data`. Si el volumen no está montado, la base de datos se crea dentro de la capa efímera y cualquier redeploy borra los datos. Tras montarlo, **haz Redeploy** (no solo Restart) para recrear el contenedor con el montaje.

#### 2) Falta `JWT_SECRET` o es demasiado corto

En los logs: `JWT_SECRET : ⚠ corto o por defecto`. El sistema arranca, pero los tokens son falsificables. Genera uno con `openssl rand -hex 32` y añádelo. Lo mismo para `SETTINGS_ENC_KEY` (cifra los tokens guardados en la BD): si la cambias después, los secretos guardados dejan de descifrarse y hay que volver a pegarlos.

#### 3) El healthcheck mata el contenedor

Si EasyPanel tiene configurado un **Healthcheck Path**, borra el campo (o pon `/health`) y deja el del Dockerfile, que ya viene con `start-period` de 40 s. Este proyecto aplica **migraciones y seed en el primer arranque**, y en planes pequeños eso puede tardar 20-40 s.

#### 4) El build falla por memoria o tiempo

El paso 2 de la imagen compila el panel con Vite y necesita ~1 GB de RAM. Si el log del **build** se corta sin error claro, sube la memoria del builder o compila la imagen en tu máquina y súbela a un registro:

```bash
docker build -t giankocr/teletimetracker:latest .
docker push giankocr/teletimetracker:latest
# En EasyPanel: Source = Docker Image, y usa esa imagen
```

#### 5) El bot no recibe mensajes (el panel sí funciona)

| Qué ves | Causa | Solución |
|---|---|---|
| `⚠ TELEGRAM_MODE=webhook pero falta PUBLIC_URL` | No definiste la URL pública | Define `PUBLIC_URL=https://tu-dominio.com` (sin barra final) o pon `TELEGRAM_MODE=polling` |
| `ℹ Bot deshabilitado (sin token…)` | Falta el token | *Configuración → TELEGRAM_BOT_TOKEN → Guardar* (no hace falta rebuild) |
| `⚠ No se pudo inicializar el bot: Not Found` | El token es inválido o está mal copiado | Pulsa **Probar token** en *Configuración* y vuelve a pegarlo |
| Webhook registrado pero sin respuesta | El dominio cambió o no es HTTPS | Vuelve a pulsar **Registrar webhook**, o usa `TELEGRAM_MODE=polling` |

> **Recomendación para el primer despliegue:** pon `TELEGRAM_MODE=polling`. No necesita dominio, ni webhook, ni `PUBLIC_URL`: el bot pregunta a Telegram directamente. Cuando el panel esté estable, cambia a `webhook` si lo prefieres.

#### 6) Comprobaciones de una línea

```bash
# ¿El contenedor está vivo y puede escribir su volumen?
curl -s https://TU-DOMINIO/health
#   → {"status":"ok",...,"dataDir":{"writable":true}}

# ¿La base de datos responde?
curl -s https://TU-DOMINIO/api/health
#   → {"status":"ok","db":"up"}

# Diagnóstico completo (requiere iniciar sesión como admin)
curl -s -H "Authorization: Bearer TOKEN" https://TU-DOMINIO/api/diagnostics
```

#### 7) Volver a empezar de cero

Si algo quedó a medias, borra el volumen y redeploya: el arranque recrea el esquema y el usuario administrador automáticamente (perderás los datos, es un entorno nuevo).

### 5.8 Despliegue automático en cada push (GitHub Actions)

El repositorio incluye `.github/workflows/deploy.yml`: cada push a `main` llama al **webhook de deploy** de EasyPanel y luego comprueba que el panel revive.

**Configuración (una sola vez):**

1. En EasyPanel: abre tu **App** → pestaña **Deployments** y copia la URL del webhook (tiene la forma `https://tu-panel/api/deploy/<token>`).
2. En GitHub: **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Obligatorio | Valor |
|---|---|---|
| `EASYPANEL_DEPLOY_URL` | Sí | La URL del webhook de EasyPanel |
| `APP_HEALTH_URL` | Recomendado | `https://tu-dominio/health` — el workflow espera hasta 5 min a que responda |

3. Haz un push a `main` y mira la pestaña **Actions**.

> ⚠️ **El token del webhook es un secreto**: cualquiera que lo tenga puede forzar despliegues. Va **siempre** en GitHub Secrets, nunca en el repositorio (que es público). El escáner de `scripts/check-secrets.mjs` bloquea el commit si detecta una URL con `/api/deploy/<token>`.

**Cómo sustituirlo por un runner propio** (alternativa sin depender del webhook): en EasyPanel, App → Deployments → activa **GitHub** como origen; así EasyPanel escucha los push directamente y no hace falta el workflow.

### 5.9 Actualizaciones y respaldos

```bash
# Actualizar: haz push y en EasyPanel pulsa Deploy (el volumen se conserva).
# Backup de SQLite (desde el host de EasyPanel o con docker exec):
docker exec teletimetracker sh -c 'cp /app/data/teletimetracker.db /app/data/backup-$(date +%F).db'
```

---

## 💻 6. Desarrollo local

```bash
# 1) Dependencias
npm install

# 2) Variables de entorno (para local usa DATA_DIR=./data)
cp .env.example .env
#   edita .env:  DATA_DIR=./data  ·  NODE_ENV=development  ·  JWT_SECRET=...

# 3) Esquema + datos iniciales
npm run prisma:generate
DATABASE_URL="file:$PWD/data/teletimetracker.db" npx prisma migrate deploy --schema=server/prisma/schema.prisma
npm run seed

# 4) Backend (http://localhost:8080) y panel en modo dev (http://localhost:5173)
npm run dev:server
npm run dev:web        # en otra terminal; Vite hace proxy de /api al backend

# 5) Build de producción y arranque del contenedor único
npm run build && npm start
```

Con Docker:

```bash
cp .env.example .env      # ajusta secretos y tokens
docker compose up -d --build
# Panel: http://localhost:8080
```

### Endpoints principales de la API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/auth/config` | Config pública del login (empresa, `bot_id`, disponibilidad de Telegram y de OTP) |
| `POST` | `/api/auth/telegram/oauth` | Login con Telegram OAuth (acepta los campos o el hash `#tgAuthResult`) |
| `POST` | `/api/auth/telegram/oidc` | **Login vigente**: recibe el `id_token` de Telegram y lo valida contra el JWKS |
| `GET` | `/api/auth/telegram/oidc/config` | Datos públicos del flujo OIDC (Client ID, scopes, endpoints) |
| `POST`/`GET` | `/api/auth/telegram/widget` | *(en desuso)* widget iframe legacy: form-urlencoded → HTML con sesión |
| `POST` | `/api/auth/phone/request` · `/phone/verify` | Acceso con teléfono + código enviado por el bot |
| `GET/PATCH/DELETE` | `/api/users/bot-contacts` | Solicitudes de acceso llegadas desde el bot |
| `GET` | `/api/auth/telegram/login` | *(compatibilidad)* Login Widget clásico |
| `POST` | `/api/auth/login` · `/refresh` · `/logout` | Sesión |
| `GET/PATCH` | `/api/auth/me` · `POST /api/auth/change-password` | Perfil propio |
| `POST` | `/api/auth/telegram/link-code` | Código de vinculación |
| `GET/POST/PATCH/DELETE` | `/api/users`, `/api/roles`, `/api/clients`, `/api/projects`, `/api/task-types`, `/api/pending-tasks` | CRUD del catálogo |
| `GET` | `/api/entries` · `/api/entries/active` | Historial y cronómetro |
| `POST` | `/api/entries/start` · `/pause` · `/resume` · `/stop` · `/cancel` | Control del cronómetro |
| `GET` | `/api/reports/dashboard` · `/team` · `/activity` · `/export.csv` | Reportes |
| `GET/PUT` | `/api/settings` | Configuración global |
| `POST` | `/api/telegram/webhook` | Webhook de Telegram (validado por `secret_token`) |
| `GET` | `/health` · `/api/health` | Healthcheck (usado por Docker/EasyPanel) |

---

## 🔒 7. No subir credenciales al repositorio

El proyecto incluye una guardia que **bloquea cualquier commit** con credenciales:

```bash
node scripts/check-secrets.mjs            # revisa los archivos versionados
node scripts/check-secrets.mjs --staged   # revisa lo que está en el índice
node scripts/check-secrets.mjs --all      # revisa todo el árbol (menos lo ignorado)
```

Detecta tokens de Telegram, claves de OpenAI/Anthropic/GitHub/AWS/Google/Stripe/Slack, bloques de clave privada y cualquier valor asignado a `JWT_SECRET`, `SETTINGS_ENC_KEY`, `TELEGRAM_WEBHOOK_SECRET`, `API_SERVICE_SECRET` o `ADMIN_PASSWORD`. También bloquea el commit si aparece un archivo que nunca debe versionarse (`.env`, `*.db`, `*.pem`, `id_rsa`, `.npmrc`).

Para activarlo como hook en tu clon (los hooks no se versionan):

```bash
ln -sf ../../scripts/check-secrets.mjs .git/hooks/pre-commit
```

Además, `.gitignore` ya excluye `.env`, `data/`, `*.db*`, `dist/`, `node_modules/` y los logs. **Nunca** guardes secretos en `docker-compose.yml`, en el `Dockerfile` ni en el `README.md`: van siempre en las variables de entorno (o en la tabla `system_settings`, que los cifra con AES-256-GCM).

## 🔒 8. Notas de seguridad

- Contraseñas con **bcrypt** (10 rondas) y política mínima (8 caracteres, letras y números).
- **JWT de acceso corto** (12 h por defecto) + **refresh token rotativo** guardado como hash SHA-256 en `auth_sessions`, revocable.
- Al cambiar la contraseña, desactivar o cambiar de rol a un usuario, **se revocan todas sus sesiones**.
- Los tokens de API (Telegram/OpenAI/GitHub) se guardan **cifrados con AES-256-GCM** y nunca se devuelven en claro al panel (se muestran enmascarados).
- El webhook de Telegram se valida con `X-Telegram-Bot-Api-Secret-Token`.
- Todas las acciones sensibles quedan registradas en `audit_logs`.
- El RBAC se evalúa **en el servidor en cada petición** leyendo el rol actual de la BD.

---

## 📋 9. Variables de entorno

Consulta `.env.example` para la lista completa y comentada. Resumen:

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Puerto y bind del contenedor |
| `DATA_DIR` | `/app/data` | Carpeta del volumen persistente |
| `DATABASE_URL` | vacío → SQLite | `file:/app/data/...` o `mysql://usuario:password@host:3306/db` |
| `AUTO_MIGRATE` / `AUTO_SEED` | `true` | Aplicar migraciones/seed al arrancar |
| `JWT_SECRET` | — | **Obligatorio** cambiar en producción |
| `JWT_EXPIRES_IN` / `REFRESH_EXPIRES_DAYS` | `12h` / `30` | Vida de los tokens |
| `SETTINGS_ENC_KEY` | — | Clave de cifrado de secretos (recomendada) |
| `CORS_ORIGINS` | `*` | Orígenes permitidos |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME` | — | Administrador inicial |
| `TELEGRAM_BOT_TOKEN` | — | Token de @BotFather |
| `TELEGRAM_MODE` | `webhook` | `webhook` · `polling` · `off` |
| `TELEGRAM_WEBHOOK_SECRET` | — | Validación del webhook |
| `PUBLIC_URL` | — | Dominio público (sin barra final) |
| `TELEGRAM_LOGIN_CLIENT_ID` / `_SECRET` | — | Client ID y Secret de BotFather → Login Widget (login web OIDC) |
| `TELEGRAM_LOGIN_MODE` | `oidc` | `oidc` (vigente) · `oauth` / `widget` (en desuso) |
| `GROQ_API_KEY` | — | **Recomendado** para los audios: transcripción + NLU |
| `GROQ_WHISPER_MODEL` / `GROQ_LLM_MODEL` | `whisper-large-v3` / `llama-3.1-8b-instant` | Modelos de Groq |
| `OPENAI_API_KEY` | — | Alternativa (Whisper + NLU) |
| `WHISPER_MODEL` / `NLU_MODEL` | `whisper-1` / `gpt-4o-mini` | Modelos |
| `GITHUB_TOKEN` / `GITHUB_ENRICH` | — / `true` | Integración GitHub |
| `ALERTS_ENABLED` / `ALERT_CRON` / `DIGEST_CRON` | `true` / `* * * * *` / `0 8 * * 1-5` | Alertas |
| `DEFAULT_TIMEZONE` | `America/Bogota` | Zona horaria por defecto |

---

## ✅ 10. Verificación realizada

El proyecto se validó de extremo a extremo:

- `npm install` + `prisma generate` + **migración inicial aplicada**.
- `tsc --noEmit` **sin errores** en el backend y build de producción del panel (Vite).
- Arranque del contenedor: **migra y hace seed automáticamente** en el primer boot (17 tablas + roles + admin + 10 tipos de tarea).
- Pruebas de API: login, RBAC, CRUD de clientes/proyectos/usuarios, cronómetro (start → pause → resume → stop con pausas descontadas), registro manual, dashboard, CSV y auditoría.
- **Conversación real por webhook de Telegram**: vinculación con código, inicio por lenguaje natural, pausa, reanudar, cambio de tarea, fin de tarea, reporte, pendientes y botones inline.
- **Nota de voz**: descarga del audio → transcripción → NLU → apertura y cierre del registro con proyecto, cliente y tipo de tarea correctos.
- **Formatos de audio**: verificado que los 8 escenarios de entrada (nota de voz `.oga`, sin extensión, `.ogg`, `.mp3`, `.m4a`, `.webm`, MIME sin extensión y `.amr`) se suben con un nombre y `Content-Type` que Groq acepta.
- **Groq**: cliente apuntando a `https://api.groq.com/openai/v1` con modelo `whisper-large-v3` (verificado) y NLU con `llama-3.1-8b-instant`; la cadena completa de nota de voz crea el registro correcto. Clave inválida → `401 Invalid API Key` detectado por la prueba de claves del panel.
- **Acceso con Telegram**: firma válida → JWT + RBAC; firma manipulada, autorización de 2 h y Telegram sin vincular → rechazados (401/403) y auditados. Formatos de hash `#tgAuthResult` y campos directos verificados.
- **Widget oficial (legacy)**: POST form-urlencoded con firma válida → HTML con `accessToken`/`refreshToken` y `postMessage` al panel; Telegram sin vincular → HTML de error legible; firma manipulada → rechazado sin sesión; `GET` con query params → también funciona.
- **Login OIDC (vigente)**: `id_token` válido → sesión y RBAC; firma ajena, `aud` o `iss` incorrectos, token expirado y `alg: none` → rechazados con el código de error correspondiente; `nonce` verificado; el `phone_number` del token se guarda en el perfil; cabecera `Cross-Origin-Opener-Policy: same-origin-allow-popups` presente (sin ella el popup de Telegram no comunica).
- **Alta guiada por el bot**: flujo verificado de extremo a extremo (catálogo vacío → el bot pide cliente → crea `Acme Corp` → pide proyecto → crea `Portal Web` → arranca el cronómetro con el título, el tipo y el cliente correctos → `/tiempo` devuelve el acumulado → una segunda tarea reconoce el proyecto sin preguntar).
- **MySQL de punta a punta desde la imagen**: partiendo del cliente generado para SQLite (como en el Dockerfile) y con `DATABASE_URL` de MySQL, el arranque cambia el cliente solo, aplica las migraciones y siembra; un segundo arranque no re-aplica nada, y una base con tablas preexistentes se adopta sin recrearlas.
- **MySQL**: verificado contra un servidor MySQL 8.4 real: migración inicial (17 tablas), seed automático, arranque de la app y flujo completo de API (login, RBAC, CRUD, cronómetro start→pause→resume→stop con pausas descontadas, registro manual, dashboard, CSV, auditoría). Tipos nativos aplicados (`description` → `TEXT`, `permissions` → `VARCHAR(600)`).
- **Acceso con teléfono + OTP**: teléfono no registrado (404), código incorrecto (401), anti-spam de 60 s (429), código correcto (200 con sesión) y reutilización del mismo código (401).
- **Vinculación desde el bot**: compartir el número sin cuenta → solicitud PENDING visible para el admin; aprobación → cuenta creada con rol y Telegram vinculado; segundo intento → vinculación automática; contacto ajeno → rechazado.
