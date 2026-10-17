/**
 * Huddle's words in English and Spanish, picked by Claude Code's `language` setting, then by what the person types,
 * then the locale (nothing to configure). Messages to other agents go out in the sender's language.
 */
import type { AlertKind } from '../types'

export type Lang = 'en' | 'es'

const EN = {
  reason: (kind: AlertKind, n: number): string =>
    kind === 'overlap'
      ? `both edited ${n} file${n === 1 ? '' : 's'}`
      : kind === 'hot'
        ? 'both touch single-owner files (lockfile, package.json, migrations, schema)'
        : kind === 'checkout'
          ? 'same working copy (no worktree of its own)'
          : 'same repo, another copy or worktree',
  none: 'none yet',
  noTask: '(no task stated)',
  clash: 'Clash',
  otherAgent: 'Another agent',
  in: 'in',
  recommend: 'Coordinating is recommended.',
  coordinate: 'Coordinate',
  addToHuddle: 'Add to huddle',
  snooze: 'Snooze 30 min',
  more: (n: number) => `+${n} more`,
  sentTo: (n: number) => `Sent to ${n}`,
  failedN: (n: number) => ` · ${n} failed`,
  status: (n: number, repo: string) => `👥 ${n} agents in ${repo}`,
  statusHuddle: (n: number) => `👥 Huddle · ${n} agents`,
  huddleWith: (n: number) => `Huddle with ${n} sessions`,
  aMember: 'a huddle member',
  ledBy: 'led by',
  ledByYou: 'led by you',
  confirmed: (c: number, n: number) => `${c}/${n} confirmed`,
  editedOwned: (editor: string, file: string, owner: string) => `${editor} edited ${file} (owner ${owner})`,
  toastOwner: (file: string, owner: string) => `You edited ${file}, which the huddle gave to ${owner}.`,
  toastAllIn: 'Everyone active here is already in the huddle.',
  toastAdded: (n: number) => `Added ${n} session${n === 1 ? '' : 's'} to the huddle.`,
  toastClash: (repo: string, reason: string) => `Clash with another agent in ${repo}: ${reason}. Coordinate from the band.`,
  toastNoPeers: 'No other agents are active in this repo anymore.',
  openFailed: "Couldn't open that session. Find it by name in the sidebar.",
  toastSent: (n: number) => `Huddle sent to ${n} session${n === 1 ? '' : 's'}.`,
  toastPartial: (sent: number, failed: number) => `Huddle sent to ${sent}; ${failed} failed.`,
  commandDescription: 'Coordinate with the other Claude sessions working in this repo',
  commandNotRepo: 'Huddle only works inside a git repository.',
  toolPeers:
    'Lists the other Claude sessions active in this same repo: id, task, branch, clash level (1 same repo, 2 same working copy, 3 same files) and the files in conflict.',
  toolSend:
    'Sends a message to another Claude session in this repo to coordinate work (use the sessionId the peers tool gives).',
  toolAgree:
    "Huddle leader only: records the agreement (one owner per disputed file, plus a short summary) and sends it to every member. Call it once, when the members' replies are in.",
  agreeNoHuddle: 'There is no huddle led by this session.',
  agreeNotLeader: 'Only the huddle leader can call agree.',
  agreeBadInput: 'agree needs a summary and at least one owner with a path and a sessionId.',
  agreeBadRepo: (repo: string) => `Unknown repo «${repo}». Use a repo name or key from the peers tool.`,
  agreeDone: (sent: number, failed: number) =>
    `Agreement recorded and sent to ${sent} session${sent === 1 ? '' : 's'}${failed ? `; ${failed} failed` : ''}.`,
  peersNone: 'No other sessions are active in this repo.',
  delivered: 'Delivered.',
  notDelivered: (why: string) => `Not delivered: ${why}`,
  peerMessage: (p: {
    repo: string; level: number; reason: string; id: string; task: string; branch: string; path: string
    files: string; clash: string | null; leader: string; marker: string
  }) =>
    [
      `[huddle] The user asked to coordinate the sessions working in the repo ${p.repo} (level ${p.level}: ${p.reason}).`,
      `Initiating session (id ${p.id}): ${p.task} · branch ${p.branch} · ${p.path}`,
      `Files it has edited: ${p.files}.`,
      p.clash ? `Files in conflict: ${p.clash}.` : '',
      'Protocol:',
      `1. Reply to the leader (sessionId ${p.leader}) with the huddle send tool or with SendMessage: your task, the files you edited and the ones you plan to touch.`,
      '2. Agree on one owner for each disputed file and on the order of work: whoever goes first finishes and commits first; the other updates (pull/rebase) before touching those files. Lockfile, package.json, migrations, schema and generated files have a single owner.',
      '3. If you share the same working copy: nobody runs checkout, stash, reset or installs dependencies without telling the other, and you commit only your own files with a pathspec (git commit -- <files>), never everything that is dirty.',
      "4. Don't edit the other session's files without agreement. While the agreement lands, keep working on what doesn't clash.",
      '5. Respect your original instruction. If your task already includes committing, pushing or publishing, still do it, but in the agreed order and carefully (update first, verify after). If it was not asked of you, coordinating is not a reason to do it. Coordinating is never a reason to stop doing what you were asked.',
      'The leader closes with the agreement (the huddle agree tool), which reaches everyone.',
      p.marker,
    ]
      .filter(Boolean)
      .join('\n'),
  addedNotice: (names: string, marker: string) =>
    `[huddle] I added these sessions to the huddle: ${names}. They received the protocol and will reply to you, the leader.\n${marker}`,
  agreeMessage: (p: { summary: string; owners: string[]; marker: string }) =>
    [
      '[huddle] The leader recorded the agreement. Follow it and keep doing your original task.',
      p.summary,
      p.owners.length ? `Owners:\n${p.owners.join('\n')}` : '',
      p.marker,
    ]
      .filter(Boolean)
      .join('\n'),
  ownerConflict: (file: string, owner: string) =>
    `[huddle] Heads-up: in the huddle agreement ${file} belongs to ${owner}, and you just edited it. Stop editing it; tell the owner with the huddle send tool, or hand them the change.`,
  midTurnNote: (from: string, text: string) =>
    `[huddle] A message from ${from} arrived while you were working:\n${text}`,
  leadIntro: (repo: string) =>
    `[huddle] The user asked to coordinate this session with the others working in ${repo}. I already sent them the coordination protocol.`,
  leadRow: (p: { id: string; level: number; reason: string; task: string; branch: string; clash: string | null; failed: boolean }) =>
    `- ${p.id} · level ${p.level} (${p.reason}) · ${p.task} · branch ${p.branch}` +
    (p.clash ? ` · conflict in: ${p.clash}` : '') +
    (p.failed ? ' · ⚠ the message could not be delivered' : ''),
  leadClose:
    'You lead. The protocol already went out: do not message them until they reply. When the replies are in, call the huddle agree tool once with one owner per disputed file and a 3-line summary; it reaches everyone. Then keep doing your task and give the user the summary. Keep to your original instruction: commit or publish only if that was already part of your task, and then in the agreed order.',
  familyBy: 'started by',
  familyMother: (name: string) => `started by ${name}`,
  familyDaughters: (n: number) => `${n} daughter${n === 1 ? '' : 's'}`,
  sisterSuffix: ' · sister session',
  sisterClashToMother: (me: string, sister: string, files: string) =>
    `[huddle] Two of the sessions you started, ${me} and ${sister}, are editing the same files (${files}). You split the work between them, so settle which of them owns those files and tell them.`,
  leadAdded: (names: string) =>
    `[huddle] I added these sessions to the huddle: ${names}. The protocol already went out: do not message them until they reply. When their replies are in, call the huddle agree tool again with the updated owners and summary.`,
}

export type Words = typeof EN

const ES: Words = {
  reason: (kind, n) =>
    kind === 'overlap'
      ? `ambos editaron ${n} archivo${n === 1 ? '' : 's'}`
      : kind === 'hot'
        ? 'ambos tocan archivos de dueño único (lockfile, package.json, migraciones, schema)'
        : kind === 'checkout'
          ? 'misma copia de trabajo (sin worktree propio)'
          : 'mismo repo, otra copia o worktree',
  none: 'ninguno aún',
  noTask: '(sin tarea declarada)',
  clash: 'Choque',
  otherAgent: 'Otro agente',
  in: 'en',
  recommend: 'Se recomienda coordinar.',
  coordinate: 'Coordinar',
  addToHuddle: 'Añadir al huddle',
  snooze: 'Silenciar 30 min',
  more: n => `+${n} más`,
  sentTo: n => `Enviado a ${n}`,
  failedN: n => ` · falló ${n}`,
  status: (n, repo) => `👥 ${n} agentes en ${repo}`,
  statusHuddle: n => `👥 Huddle · ${n} agentes`,
  huddleWith: n => `En huddle con ${n} sesiones`,
  aMember: 'un miembro del huddle',
  ledBy: 'lidera',
  ledByYou: 'lo lideras tú',
  confirmed: (c, n) => `${c}/${n} confirmaron`,
  editedOwned: (editor, file, owner) => `${editor} editó ${file} (dueño ${owner})`,
  toastOwner: (file, owner) => `Editaste ${file}, que el huddle asignó a ${owner}.`,
  toastAllIn: 'Todos los activos aquí ya están en el huddle.',
  toastAdded: n => `Se añadió ${n} sesi${n === 1 ? 'ón' : 'ones'} al huddle.`,
  toastClash: (repo, reason) => `Choque con otro agente en ${repo}: ${reason}. Coordina desde la banda.`,
  toastNoPeers: 'Ya no hay otros agentes activos en este repo.',
  openFailed: 'No pude abrir esa sesión. Búscala por nombre en el sidebar.',
  toastSent: n => `Huddle enviado a ${n} sesi${n === 1 ? 'ón' : 'ones'}.`,
  toastPartial: (sent, failed) => `Huddle enviado a ${sent}; falló con ${failed}.`,
  commandDescription: 'Coordina con las otras sesiones de Claude que trabajan en este repo',
  commandNotRepo: 'Huddle solo funciona dentro de un repositorio git.',
  toolPeers:
    'Lista las otras sesiones de Claude activas en este mismo repo: id, tarea, rama, nivel de choque (1 mismo repo, 2 misma copia, 3 mismos archivos) y archivos en choque.',
  toolSend:
    'Envía un mensaje a otra sesión de Claude del mismo repo para coordinar trabajo (usa el sessionId que da la herramienta peers).',
  toolAgree:
    'Solo el líder del huddle: registra el acuerdo (un dueño por archivo en disputa y un resumen corto) y lo envía a todos los miembros. Llámala una vez, cuando ya llegaron las respuestas.',
  agreeNoHuddle: 'Esta sesión no lidera ningún huddle.',
  agreeNotLeader: 'Solo el líder del huddle puede llamar a agree.',
  agreeBadInput: 'agree necesita un resumen y al menos un dueño con path y sessionId.',
  agreeBadRepo: repo => `Repo desconocido «${repo}». Usa un nombre o clave de repo de la herramienta peers.`,
  agreeDone: (sent, failed) =>
    `Acuerdo registrado y enviado a ${sent} sesi${sent === 1 ? 'ón' : 'ones'}${failed ? `; falló con ${failed}` : ''}.`,
  peersNone: 'No hay otras sesiones activas en este repo.',
  delivered: 'Entregado.',
  notDelivered: why => `No se entregó: ${why}`,
  peerMessage: p =>
    [
      `[huddle] El usuario pidió coordinar las sesiones que trabajan en el repo ${p.repo} (nivel ${p.level}: ${p.reason}).`,
      `Sesión que inicia (id ${p.id}): ${p.task} · rama ${p.branch} · ${p.path}`,
      `Archivos que ha editado: ${p.files}.`,
      p.clash ? `Archivos en choque: ${p.clash}.` : '',
      'Protocolo:',
      `1. Contesta al líder (sessionId ${p.leader}) con la herramienta send de huddle o con SendMessage: tu tarea, los archivos que editaste y los que planeas tocar.`,
      '2. Acuerden un dueño por cada archivo en disputa y el orden de trabajo: quien va primero termina y commitea primero; el otro actualiza (pull/rebase) antes de tocar esos archivos. Lockfile, package.json, migraciones, schema y generados tienen un solo dueño.',
      '3. Si comparten la misma copia de trabajo: nadie hace checkout, stash, reset ni instala dependencias sin avisar al otro, y tú commiteas solo tus archivos con pathspec (git commit -- <archivos>), nunca todo lo que esté sucio.',
      '4. No edites archivos del otro sin acuerdo. Mientras llega el acuerdo, sigue con lo que no choca.',
      '5. Respeta tu instrucción original. Si tu tarea ya incluye commitear, hacer push o publicar, hazlo igual, pero en el orden acordado y con cuidado (actualiza antes, verifica después). Si no te lo pidieron, coordinarte no es razón para hacerlo. Coordinarte nunca es razón para dejar de hacer lo que te pidieron.',
      'El líder cierra con el acuerdo (la herramienta agree de huddle), que le llega a todos.',
      p.marker,
    ]
      .filter(Boolean)
      .join('\n'),
  addedNotice: (names, marker) =>
    `[huddle] Añadí estas sesiones al huddle: ${names}. Recibieron el protocolo y te contestarán a ti, el líder.\n${marker}`,
  agreeMessage: p =>
    [
      '[huddle] El líder registró el acuerdo. Síguelo y continúa con tu tarea original.',
      p.summary,
      p.owners.length ? `Dueños:\n${p.owners.join('\n')}` : '',
      p.marker,
    ]
      .filter(Boolean)
      .join('\n'),
  ownerConflict: (file, owner) =>
    `[huddle] Ojo: en el acuerdo del huddle ${file} es de ${owner}, y acabas de editarlo. Deja de editarlo; avísale al dueño con la herramienta send de huddle o entrégale el cambio.`,
  midTurnNote: (from, text) => `[huddle] Llegó un mensaje de ${from} mientras trabajabas:\n${text}`,
  leadIntro: repo =>
    `[huddle] El usuario pidió coordinar esta sesión con las otras que trabajan en ${repo}. Ya les envié el protocolo de coordinación.`,
  leadRow: p =>
    `- ${p.id} · nivel ${p.level} (${p.reason}) · ${p.task} · rama ${p.branch}` +
    (p.clash ? ` · choque en: ${p.clash}` : '') +
    (p.failed ? ' · ⚠ no se le pudo entregar el mensaje' : ''),
  leadClose:
    'Lidera tú. El protocolo ya salió: no les escribas hasta que contesten. Cuando lleguen las respuestas, llama una sola vez a la herramienta agree de huddle con un dueño por archivo en disputa y un resumen de 3 líneas; le llega a todos. Luego sigue con tu tarea y dale el resumen al usuario. Respeta tu instrucción original: commitea o publica solo si eso ya era parte de tu tarea, y entonces en el orden acordado.',
  familyBy: 'la inició',
  familyMother: name => `la inició ${name}`,
  familyDaughters: n => `${n} hija${n === 1 ? '' : 's'}`,
  sisterSuffix: ' · sesión hermana',
  sisterClashToMother: (me, sister, files) =>
    `[huddle] Dos de las sesiones que iniciaste, ${me} y ${sister}, están editando los mismos archivos (${files}). Tú repartiste el trabajo entre ellas, así que define cuál es dueña de esos archivos y avísales.`,
  leadAdded: names =>
    `[huddle] Añadí estas sesiones al huddle: ${names}. El protocolo ya salió: no les escribas hasta que contesten. Cuando lleguen sus respuestas, llama otra vez a la herramienta agree de huddle con los dueños y el resumen actualizados.`,
}

export const words = (lang: Lang): Words => (lang === 'es' ? ES : EN)

/**
 * Spanish when Spanish markers outnumber English ones in what the person typed, English when the reverse, null on a
 * tie (a prompt like "ok" says nothing).
 */
export function inferLang(text: string): Lang | null {
  const t = text.toLowerCase()
  const es = (t.match(/[¿¡áéíóúñ]/g) ?? []).length + (t.match(ES_WORDS) ?? []).length
  const en = (t.match(EN_WORDS) ?? []).length
  return es > en ? 'es' : en > es ? 'en' : null
}

const ES_WORDS = /(?<![\p{L}\p{N}])(?:que|de|la|el|los|las|para|por|una|con|está|ya|sí|también|pero|como|esto|esta|cómo)(?![\p{L}\p{N}])/gu
const EN_WORDS = /(?<![\p{L}\p{N}])(?:the|and|to|is|of|for|with|this|that|please|it|in|on|are|you)(?![\p{L}\p{N}])/gu

/**
 * Claude Code's `language` setting, then what the person's own prompts read as, then LC_ALL/LANG; English otherwise.
 * An explicit 'en' or 'es' first wins (tests).
 */
export function pickLang(option: unknown, settingsLanguage: unknown, locale: string | null, inferred?: Lang | null): Lang {
  if (option === 'en' || option === 'es') return option
  const s = typeof settingsLanguage === 'string' ? settingsLanguage.toLowerCase() : ''
  if (s) return s.startsWith('es') || s.startsWith('span') || s.startsWith('espa') ? 'es' : 'en'
  if (inferred) return inferred
  return (locale ?? '').toLowerCase().startsWith('es') ? 'es' : 'en'
}
