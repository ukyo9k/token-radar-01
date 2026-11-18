// The dashboard dossier (makefun/dossier/v1), written from the format's own
// description: one canonical JSON object holding the screenshots and a text of
// the dashboard's source, capped at a byte budget. The scorer rebuilds this
// same dossier from the output directory and compares bytes, so this file is
// written to match that format exactly: same headings, same fences, same cut
// rule, same key order. Nothing here reaches the network; it only reads the
// output directory this program just wrote.
//
// A dossier is:
//   schema   "makefun/dossier/v1"
//   cover    0: the first screenshot by name is the cover
//   images   the PNG and JPEG files in screenshots/, in name order, each with
//            its name, media type, sha256 and base64 body
//   text     a "## Dashboard" block (file count, total bytes, every file's path
//            with its size), then "## Source", each text file's path, size and
//            line count and its contents in a fenced block, every file by path
//
// The text holds at most text_max_bytes UTF-8 bytes: every file that fits goes
// in whole, in path order; the first that does not goes in up to its last
// complete line that fits, with a line saying how many of its lines are not
// shown; nothing follows it but a last line naming how many whole files and
// bytes were left out. A file whose extension is not one of .html .css .js
// .json .mjs .svg .md .txt is named in the Dashboard block and not shown.

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';

export const DOSSIER_SCHEMA = 'makefun/dossier/v1';
export const DOSSIER_MAX_BYTES = 4 * 1024 * 1024;
export const DOSSIER_MAX_IMAGES = 8;

const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const TEXT_FILE = /\.(?:html|css|js|json|mjs|svg|md|txt)$/;

export interface DossierCaps {
  text_max_bytes: number;
  screenshots?: { max: number; max_bytes: number };
  dashboard?: { max_files: number; max_bytes: number };
}

export class DossierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DossierError';
  }
}

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');
const hashHex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function startsWithMagic(bytes: Uint8Array, magic: readonly number[]): boolean {
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

/**
 * A regular file's bytes, at most `cap` long. A link, a directory or a
 * missing file is a DossierError naming what went wrong.
 */
function readFileCapped(path: string, cap: number, what: string): Uint8Array {
  let size: number;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) throw new DossierError(`buildDossier: ${what} is not a regular file`);
    size = st.size;
  } catch (err) {
    if (err instanceof DossierError) throw err;
    throw new DossierError(`buildDossier: ${what} cannot be read`);
  }
  if (size > cap) throw new DossierError(`buildDossier: ${what} is ${size} bytes, over the ${cap} a dossier reads`);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new DossierError(`buildDossier: ${what} is not a regular file`);
  }
  try {
    const now = fstatSync(fd).size;
    if (now > cap) throw new DossierError(`buildDossier: ${what} is ${now} bytes, over the ${cap} a dossier reads`);
    const buf = Buffer.alloc(now);
    let at = 0;
    while (at < buf.length) {
      const n = readSync(fd, buf, at, buf.length - at, at);
      if (n === 0) break;
      at += n;
    }
    return new Uint8Array(buf.buffer, buf.byteOffset, at);
  } finally {
    closeSync(fd);
  }
}

/** Lines of a text: 0 when empty, else its newlines plus one for a last line with none. */
function countLines(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  let n = 0;
  for (const b of bytes) if (b === 0x0a) n++;
  return bytes[bytes.length - 1] === 0x0a ? n : n + 1;
}

/** A Markdown fence one backtick longer than the longest run in the body, three at least. */
function fenceFor(body: string): string {
  let longest = 0;
  for (const run of body.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** The language a fence opens with: the file's extension, mjs shown as js. */
function languageOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1);
  return ext === 'mjs' ? 'js' : ext;
}

/**
 * JSON with every object's keys in code-unit order and no whitespace: one
 * spelling per value, so the same dossier always hashes the same.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${value} is not a finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new TypeError('canonicalJson: only plain objects and arrays');
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort(compareStrings)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  throw new TypeError(`canonicalJson: a ${typeof value} has no JSON form`);
}

interface DashFile {
  path: string;
  size: number;
}

/**
 * Every regular file under the dashboard tree, in path order, with its size.
 * Refuses a dot-directory, a badly named file, an entry that is neither a
 * file nor a directory, and, when caps are given, too many files or bytes.
 */
function collectDashboardFiles(root: string, caps: { max_files: number; max_bytes: number } | null): DashFile[] {
  let st: import('node:fs').Stats;
  try {
    st = lstatSync(root);
  } catch {
    throw new DossierError('buildDossier: no dashboard/ directory: the page and its source are what the judge reads');
  }
  if (!st.isDirectory()) throw new DossierError('buildDossier: dashboard is not a directory');
  const found: DashFile[] = [];
  let total = 0;
  const stack: string[] = [''];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    const dir = rel === '' ? root : join(root, rel);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) throw new DossierError(`buildDossier: dashboard/${p} is a dot-directory`);
        stack.push(p);
      } else if (entry.isFile()) {
        if (!PLAIN_NAME.test(entry.name)) {
          throw new DossierError(
            `buildDossier: dashboard/${p}: a file's name is letters, digits and . _ -, 1 to 128 characters, not starting with . or -`,
          );
        }
        const size = lstatSync(join(root, p)).size;
        found.push({ path: p, size });
        total += size;
        if (caps !== null && found.length > caps.max_files) {
          throw new DossierError(`buildDossier: dashboard/ holds more than the ${caps.max_files} files it may`);
        }
        if (caps !== null && total > caps.max_bytes) {
          throw new DossierError(`buildDossier: dashboard/'s files come to more than the ${caps.max_bytes} bytes they may`);
        }
      } else {
        throw new DossierError(`buildDossier: dashboard/${p} is neither a file nor a directory`);
      }
    }
  }
  return found.sort((a, b) => compareStrings(a.path, b.path));
}

interface ShownFile {
  bytes: Uint8Array;
  text: string;
  fence: string;
  lang: string;
  block: string;
  lines: number;
}

interface Section {
  heading: string;
  file: ShownFile | null;
  size: number;
  bytes: number;
}

/**
 * A file's section cut inside its contents: its heading, its first k lines
 * in its fence (closed), a line naming how many of its lines are not shown,
 * then the cut line, k the most lines (at least one, fewer than all) whose
 * whole fits in `room` bytes; null when not one line fits. It cuts only
 * after a line's LF, which is never inside a UTF-8 sequence, so no character
 * is split.
 */
function cutSectionHead(heading: string, file: ShownFile, room: number, tail: (hidden: number) => string): string | null {
  const total = file.lines;
  const lines = file.text.split('\n');
  const open = `${file.fence}${file.lang}\n`;
  const close = `${file.fence}\n\n`;
  const note = (k: number): string => `[${total - k} of this file's ${total} lines not shown.]\n`;
  const fixed = utf8Bytes(heading) + utf8Bytes(open) + utf8Bytes(close);
  let best = 0;
  let shown = 0;
  let raw = 0;
  for (let k = 1; k < total; k++) {
    shown += utf8Bytes(lines[k - 1]!) + 1;
    raw = file.bytes.indexOf(0x0a, raw) + 1;
    if (fixed + shown + utf8Bytes(note(k)) + utf8Bytes(tail(file.bytes.length - raw)) <= room) best = k;
  }
  if (best === 0) return null;
  let rawEnd = 0;
  for (let k = 0; k < best; k++) rawEnd = file.bytes.indexOf(0x0a, rawEnd) + 1;
  const head = lines.slice(0, best).map((l) => `${l}\n`).join('');
  return `${heading}${open}${head}${close}${note(best)}${tail(file.bytes.length - rawEnd)}`;
}

/**
 * The dossier of an output directory, as canonical JSON bytes: the
 * screenshots plus a text of the dashboard's source, capped at
 * caps.text_max_bytes. The caps only refuse, except text_max_bytes, which
 * shapes the text. Throws DossierError on a directory it cannot dossier.
 */
export function buildDossier(dir: string, caps: DossierCaps): Uint8Array {
  const max = caps.text_max_bytes;
  if (!Number.isSafeInteger(max) || max <= 0) {
    throw new DossierError(`buildDossier: caps.text_max_bytes must be a positive integer, not ${String(max)}`);
  }

  let imageCap = { n: DOSSIER_MAX_IMAGES, whose: 'a dossier holds' };
  let imageBytesCap = { n: DOSSIER_MAX_BYTES, whose: 'a dossier holds' };
  if (caps.screenshots !== undefined) {
    const s = caps.screenshots as { max?: unknown; max_bytes?: unknown } | null;
    if (typeof s !== 'object' || s === null) throw new DossierError('buildDossier: caps.screenshots must be an object {max, max_bytes}');
    for (const k of ['max', 'max_bytes'] as const) {
      const v = s[k];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
        throw new DossierError(`buildDossier: caps.screenshots.${k} must be a positive integer, not ${String(v)}`);
      }
    }
    if ((s.max as number) < imageCap.n) imageCap = { n: s.max as number, whose: 'caps.screenshots.max allows' };
    if ((s.max_bytes as number) < imageBytesCap.n) imageBytesCap = { n: s.max_bytes as number, whose: 'caps.screenshots.max_bytes allows' };
  }
  let fileCaps: { max_files: number; max_bytes: number } | null = null;
  if (caps.dashboard !== undefined) {
    const d = caps.dashboard as { max_files?: unknown; max_bytes?: unknown } | null;
    if (typeof d !== 'object' || d === null) throw new DossierError('buildDossier: caps.dashboard must be an object {max_files, max_bytes}');
    for (const k of ['max_files', 'max_bytes'] as const) {
      const v = d[k];
      if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
        throw new DossierError(`buildDossier: caps.dashboard.${k} must be a positive integer, not ${String(v)}`);
      }
    }
    fileCaps = { max_files: d.max_files as number, max_bytes: d.max_bytes as number };
  }

  const files = collectDashboardFiles(join(dir, 'dashboard'), fileCaps);

  const shotsDir = join(dir, 'screenshots');
  let shotNames: string[];
  try {
    shotNames = readdirSync(shotsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort(compareStrings);
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') throw new DossierError('buildDossier: no screenshots/ directory: the first screenshot is the cover');
    throw new DossierError('buildDossier: screenshots/ cannot be read');
  }
  if (shotNames.length === 0) throw new DossierError('buildDossier: screenshots/ holds no image: the first is the cover');
  if (shotNames.length > imageCap.n) {
    throw new DossierError(`buildDossier: screenshots/ holds ${shotNames.length} files, over the ${imageCap.n} ${imageCap.whose}`);
  }
  const images = shotNames.map((name) => {
    if (!PLAIN_NAME.test(name)) {
      throw new DossierError(`buildDossier: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters, not starting with . or -`);
    }
    const bytes = readFileCapped(join(shotsDir, name), imageBytesCap.n, `screenshots/${name}`);
    const mediaType = startsWithMagic(bytes, PNG_MAGIC) ? 'image/png' : startsWithMagic(bytes, JPEG_MAGIC) ? 'image/jpeg' : null;
    if (mediaType === null) throw new DossierError(`buildDossier: screenshots/${name} is neither a PNG nor a JPEG`);
    return { name, media_type: mediaType, sha256: hashHex(bytes), base64: Buffer.from(bytes).toString('base64') };
  });

  const head = [
    '## Dashboard',
    '',
    `Files: ${files.length} (${files.reduce((n, f) => n + f.size, 0)} bytes)`,
    ...files.map((f) => `- ${f.path} (${f.size} bytes)`),
    '',
    '## Source',
    '',
    '',
  ].join('\n');

  const shown = files.filter((f) => TEXT_FILE.test(f.path));
  const sections: Section[] = shown.map((f) => {
    const bytes = readFileCapped(join(dir, 'dashboard', f.path), DOSSIER_MAX_BYTES, `dashboard/${f.path}`);
    const lines = countLines(bytes);
    const heading = `### ${f.path}\n\n${bytes.length} bytes, ${lines} line${lines === 1 ? '' : 's'}\n\n`;
    if (bytes.length === 0) return { heading, file: null, size: utf8Bytes(heading), bytes: 0 };
    const text = new TextDecoder('utf-8').decode(bytes);
    const fence = fenceFor(text);
    const lang = languageOf(f.path);
    const block = `${fence}${lang}\n${text}${text.endsWith('\n') ? '' : '\n'}${fence}\n\n`;
    return {
      heading,
      file: { bytes, text, fence, lang, block, lines },
      size: utf8Bytes(heading) + utf8Bytes(block),
      bytes: bytes.length,
    };
  });

  // bytesAfter[k]: the bytes of the shown files after section k.
  const bytesAfter = new Array<number>(sections.length + 1).fill(0);
  for (let k = sections.length - 1; k >= 0; k--) {
    bytesAfter[k] = bytesAfter[k + 1]! + (k + 1 < sections.length ? sections[k + 1]!.bytes : 0);
  }

  const cutLine = (count: number, bytes: number): string => `[Cut at ${max} bytes: ${count} file${count === 1 ? '' : 's'} and ${bytes} bytes left out.]\n`;
  let out = head;
  let used = utf8Bytes(head);
  if (used + utf8Bytes(cutLine(0, 0)) > max) {
    throw new DossierError(`buildDossier: caps.text_max_bytes ${max} cannot hold even the Dashboard block and the cut line`);
  }
  let kept = 0;
  for (; kept < sections.length; kept++) {
    const section = sections[kept]!;
    const restCount = sections.length - kept - 1;
    const tail = restCount === 0 ? 0 : utf8Bytes(cutLine(restCount, bytesAfter[kept]!));
    if (used + section.size + tail > max) break;
    out += section.file === null ? section.heading : `${section.heading}${section.file.block}`;
    used += section.size;
  }
  if (kept < sections.length) {
    const first = sections[kept]!;
    const restCount = sections.length - kept - 1;
    const after = bytesAfter[kept]!;
    const part =
      first.file === null ? null : cutSectionHead(first.heading, first.file, max - used, (hidden) => cutLine(restCount, after + hidden));
    out += part ?? cutLine(restCount + 1, after + first.bytes);
  }
  if (utf8Bytes(out) > max) {
    throw new DossierError(`buildDossier: caps.text_max_bytes ${max} cannot hold even the Dashboard block and the cut line`);
  }

  const doc = { schema: DOSSIER_SCHEMA, cover: 0, text: out.replace(/\n+$/, '\n'), images };
  const bytes = Buffer.from(canonicalJson(doc), 'utf8');
  if (bytes.length > DOSSIER_MAX_BYTES) {
    throw new DossierError(`buildDossier: the dossier is ${bytes.length} bytes, over the ${DOSSIER_MAX_BYTES} one holds`);
  }
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.length);
}
