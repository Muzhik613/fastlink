// upload.js — fast_upload's local half: read files from THIS machine's upload folder
// and turn them into the relay tool's `files` ([{name, type, data: base64}]).
//
// Only files inside the upload folder are read (default ~/.fastlink/uploads,
// FASTLINK_UPLOAD_DIR overrides), resolved through symlinks, so a page that talks a
// model into "uploading ~/.ssh/id_rsa" gets a refusal, not the file. Size-capped to
// what one relay call carries (base64 of 10 MB stays under the 16 MB frame cap).
import { mkdirSync, openSync, readSync, closeSync, fstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';

export const UPLOAD_MAX_FILES = 10;
export const UPLOAD_MAX_BYTES = 10 * 1024 * 1024; // all files together

export function uploadDir() {
  return resolve(process.env.FASTLINK_UPLOAD_DIR || join(homedir(), '.fastlink', 'uploads'));
}

const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.heic': 'image/heic', '.heif': 'image/heif', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.3gp': 'video/3gpp', '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.zip': 'application/zip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export const mimeType = (name) => TYPES[extname(name).toLowerCase()] || 'application/octet-stream';

const mb = (n) => (n / 1024 / 1024).toFixed(1);

// paths → { files } or { error }. A relative path is taken inside the upload folder.
export function readUploads(paths, dir = uploadDir()) {
  const list = typeof paths === 'string' ? [paths] : paths;
  if (!Array.isArray(list) || !list.length || list.some((p) => typeof p !== 'string' || !p.trim())) {
    return { error: 'fast_upload needs `paths`: one or more file paths (strings).' };
  }
  if (list.length > UPLOAD_MAX_FILES) return { error: `fast_upload takes at most ${UPLOAD_MAX_FILES} files per call (got ${list.length}).` };
  let root;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    root = realpathSync(dir);
  } catch (e) {
    return { error: `Can't open the upload folder ${dir}: ${e.message}` };
  }
  const where = `Only files in ${root} can be uploaded: copy the file there, then pass its name.`;
  const files = [];
  let total = 0;
  for (const p of list) {
    const asked = isAbsolute(p) ? p : join(root, p);
    let real;
    try { real = realpathSync(asked); } catch { return { error: `No file ${asked}. ${where}` }; }
    if (!real.startsWith(root + sep)) return { error: `${p} is outside the upload folder, so it was not read. ${where}` };
    let fd;
    try {
      fd = openSync(real, 'r');
      const st = fstatSync(fd);
      if (!st.isFile()) return { error: `${p} is not a file. ${where}` };
      total += st.size;
      if (total > UPLOAD_MAX_BYTES) return { error: `fast_upload carries at most ${mb(UPLOAD_MAX_BYTES)} MB per call; these files are over that (${mb(total)} MB so far).` };
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = readSync(fd, buf, off, st.size - off, off);
        if (n <= 0) break;
        off += n;
      }
      files.push({ name: basename(real), type: mimeType(real), size: off, data: buf.subarray(0, off).toString('base64') });
    } catch (e) {
      return { error: `Can't read ${p}: ${e.message}` };
    } finally {
      if (fd != null) closeSync(fd);
    }
  }
  return { files };
}

// The relay's fast_upload takes file contents (`files`); a local caller names files
// (`paths`) and this side reads them.
export function withUploadPaths(tool) {
  if (tool.name !== 'fast_upload') return tool;
  const { files: _f, ...props } = tool.inputSchema?.properties || {};
  const required = (tool.inputSchema?.required || []).filter((k) => k !== 'files');
  return {
    ...tool,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        paths: {
          type: 'array', items: { type: 'string' },
          description: `Files on this machine to upload, inside ${uploadDir()} (a name there, or an absolute path inside it); up to ${UPLOAD_MAX_FILES} files, ${mb(UPLOAD_MAX_BYTES)} MB in all.`,
        },
        ...props,
      },
      required: [...required, 'paths'],
    },
  };
}

// A local fast_upload call's arguments for the relay: `paths` read into `files`.
export function uploadArgs(args) {
  const { paths, files: _ignored, ...rest } = args;
  const r = readUploads(paths);
  if (r.error) return r;
  return { args: { ...rest, files: r.files.map(({ name, type, data }) => ({ name, type, data })) } };
}
