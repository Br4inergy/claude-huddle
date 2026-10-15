/**
 * Huddle's words in English and Spanish, picked by Claude Code's `language` setting, then the locale (nothing to
 * configure). Messages to other agents go out in the sender's language.
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
  snooze: 'Snooze 30 min',
  more: (n: number) => `+${n} more`,
  sentTo: (n: number) => `Sent to ${n}`,
  failedN: (n: number) => ` · ${n} failed`,
  status: (n: number, repo: string) => `👥 ${n} agents in ${repo}`,
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
  peersNone: 'No other sessions are active in this repo.',
  delivered: 'Delivered.',
  notDelivered: (why: string) => `Not delivered: ${why}`,
  peerMessage: (p: {
    repo: string; level: number; reason: string; id: string; task: string; branch: string; path: string
    files: string; clash: string | null
  }) =>
    [
      `[huddle] The user asked to coordinate the sessions working in the repo ${p.repo} (level ${p.level}: ${p.reason}).`,
      `Initiating session (id ${p.id}): ${p.task} · branch ${p.branch} · ${p.path}`,
      `Files it has edited: ${p.files}.`,
      p.clash ? `Files in conflict: ${p.clash}.` : '',
      'Protocol:',
      '1. Reply with SendMessage to the initiating session: your task, the files you edited and the ones you plan to touch.',
      '2. Agree on one owner for each disputed file and on the order of work: whoever goes first finishes and commits first; the other updates (pull/rebase) before touching those files. Lockfile, package.json, migrations, schema and generated files have a single owner.',
      '3. If you share the same working copy: nobody runs checkout, stash, reset or installs dependencies without telling the other.',
      "4. Don't edit the other session's files without agreement. While the agreement lands, keep working on what doesn't clash.",
      '5. Respect your original instruction. If your task already includes committing, pushing or publishing, still do it, but in the agreed order and carefully (update first, verify after). If it was not asked of you, coordinating is not a reason to do it. Coordinating is never a reason to stop doing what you were asked.',
      'The initiating session leads and closes with a summary of the agreement.',
    ]
      .filter(Boolean)
      .join('\n'),
  leadIntro: (repo: string) =>
    `[huddle] The user asked to coordinate this session with the others working in ${repo}. I already sent them the coordination protocol.`,
  leadRow: (p: { id: string; level: number; reason: string; task: string; branch: string; clash: string | null; failed: boolean }) =>
    `- ${p.id} · level ${p.level} (${p.reason}) · ${p.task} · branch ${p.branch}` +
    (p.clash ? ` · conflict in: ${p.clash}` : '') +
    (p.failed ? ' · ⚠ the message could not be delivered' : ''),
  leadClose:
    "You lead: when their replies arrive, propose a concrete split (one owner per file and the order of work) and send it with the huddle send tool (sessionId above) or by replying with SendMessage to their address. Keep to your original instruction: commit or publish only if that was already part of your task, and then in the agreed order. Follow the agreement, keep doing your task and summarize the agreement for the user in 3 lines.",
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
  snooze: 'Silenciar 30 min',
  more: n => `+${n} más`,
  sentTo: n => `Enviado a ${n}`,
  failedN: n => ` · falló ${n}`,
  status: (n, repo) => `👥 ${n} agentes en ${repo}`,
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
      '1. Contesta con SendMessage a la sesión que inicia: tu tarea, los archivos que editaste y los que planeas tocar.',
      '2. Acuerden un dueño por cada archivo en disputa y el orden de trabajo: quien va primero termina y commitea primero; el otro actualiza (pull/rebase) antes de tocar esos archivos. Lockfile, package.json, migraciones, schema y generados tienen un solo dueño.',
      '3. Si comparten la misma copia de trabajo: nadie hace checkout, stash, reset ni instala dependencias sin avisar al otro.',
      '4. No edites archivos del otro sin acuerdo. Mientras llega el acuerdo, sigue con lo que no choca.',
      '5. Respeta tu instrucción original. Si tu tarea ya incluye commitear, hacer push o publicar, hazlo igual, pero en el orden acordado y con cuidado (actualiza antes, verifica después). Si no te lo pidieron, coordinarte no es razón para hacerlo. Coordinarte nunca es razón para dejar de hacer lo que te pidieron.',
      'La sesión que inicia lidera y cierra con un resumen del acuerdo.',
    ]
      .filter(Boolean)
      .join('\n'),
  leadIntro: repo =>
    `[huddle] El usuario pidió coordinar esta sesión con las otras que trabajan en ${repo}. Ya les envié el protocolo de coordinación.`,
  leadRow: p =>
    `- ${p.id} · nivel ${p.level} (${p.reason}) · ${p.task} · rama ${p.branch}` +
    (p.clash ? ` · choque en: ${p.clash}` : '') +
    (p.failed ? ' · ⚠ no se le pudo entregar el mensaje' : ''),
  leadClose:
    'Lidera tú: cuando lleguen sus respuestas, propón un reparto concreto (dueño por archivo y orden de trabajo) y mándalo con la herramienta send de huddle (sessionId de arriba) o respondiendo con SendMessage a su dirección. Respeta tu instrucción original: commitea o publica solo si eso ya era parte de tu tarea, y entonces en el orden acordado. Cumple el acuerdo, sigue con tu tarea y resume el acuerdo al usuario en 3 líneas.',
}

export const words = (lang: Lang): Words => (lang === 'es' ? ES : EN)

/** Claude Code's `language` setting, then LC_ALL/LANG; English otherwise. An explicit 'en' or 'es' first wins (tests). */
export function pickLang(option: unknown, settingsLanguage: unknown, locale: string | null): Lang {
  if (option === 'en' || option === 'es') return option
  const s = typeof settingsLanguage === 'string' ? settingsLanguage.toLowerCase() : ''
  if (s) return s.startsWith('es') || s.startsWith('span') || s.startsWith('espa') ? 'es' : 'en'
  return (locale ?? '').toLowerCase().startsWith('es') ? 'es' : 'en'
}
