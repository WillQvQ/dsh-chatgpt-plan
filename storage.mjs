import { mkdir, open, rename, rm, chmod, lstat } from 'node:fs/promises';
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
export const defaultDirectory = () => join(homedir(), '.dsh', 'chatgpt-plan');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function owned(info) { return typeof process.getuid !== 'function' || info.uid === process.getuid(); }
export function readPrivateFileSync(path) {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || !owned(info) || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('本地凭据文件权限异常。');
    return readFileSync(fd, 'utf8');
  } finally { closeSync(fd); }
}
export async function readPrivateFile(path) {
  let file;
  try { file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error('无法安全读取本地凭据文件（可能是软链接或权限异常）。'); }
  try {
    const info = await file.stat();
    if (!info.isFile() || !owned(info) || (process.platform !== 'win32' && (info.mode & 0o077))) throw new Error('本地凭据必须是当前用户独占的普通文件（0600）。');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
export async function prepareDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !owned(info)) throw new Error('凭据目录必须由当前用户拥有，且不能是软链接。');
  await chmod(directory, 0o700);
}
export async function writePrivateFile(path, text) {
  await prepareDirectory(dirname(path));
  const tmp = join(dirname(path), `.private-${randomUUID()}.tmp`);
  const file = await open(tmp, 'wx', 0o600);
  try {
    try { await file.writeFile(text); await file.sync(); } finally { await file.close(); }
    await rename(tmp, path);
  } finally { await rm(tmp, { force: true }); }
}

/** Profile paths belong to DSH; never borrow another profile's login. */
export function profileStorage(baseUrl, legacyDirectory = defaultDirectory()) {
  if (typeof baseUrl !== 'string' || !baseUrl.startsWith('file:')) return { directory: legacyDirectory, profile: 'local' };
  const profileRoot = fileURLToPath(baseUrl);
  return { directory: join(profileRoot, 'data', 'dsh-chatgpt-plan'), profile: basename(profileRoot),
    legacyDirectory: basename(profileRoot) === 'desktop' ? legacyDirectory : undefined };
}

export class Store {
  constructor(directory = defaultDirectory()) { this.directory = directory; this.path = join(directory, 'accounts.json'); }
  async load() {
    const text = await readPrivateFile(this.path);
    if (text === undefined) return { version: 1, hostId: `urn:uuid:${randomUUID()}`, activeProfileId: null, profiles: [] };
    try {
      const value = JSON.parse(text);
      if (value.version !== 1 || typeof value.hostId !== 'string' || !Array.isArray(value.profiles)) throw new Error();
      return value;
    } catch (error) {
      throw new Error('DSH 的 ChatGPT 登录文件无法读取；为保护现有账号，未覆盖文件。');
    }
  }
  async save(value) {
    await writePrivateFile(this.path, JSON.stringify(value));
  }
  async withLock(fn) {
    await prepareDirectory(this.directory);
    const lock = join(this.directory, 'accounts.lock');
    const deadline = Date.now() + 60000;
    while (true) {
      try {
        const file = await open(lock, 'wx', 0o600);
        await file.writeFile(String(process.pid)); await file.close(); break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw new Error('无法锁定 DSH ChatGPT 登录文件。');
        try {
          const pid = Number(await readPrivateFile(lock));
          if (Number.isInteger(pid) && pid > 0) {
            try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { await rm(lock, { force: true }); continue; } }
          }
        } catch {}
        if (Date.now() >= deadline) throw new Error('另一个 DSH 登录操作尚未完成，请稍后重试。');
        await sleep(100);
      }
    }
    try { return await fn(); } finally { await rm(lock, { force: true }); }
  }
  async transact(fn) {
    return this.withLock(async () => {
      const value = await this.load();
      const result = await fn(value);
      await this.save(value);
      return result;
    });
  }
  async migrateLegacy(directory) {
    if (!directory || resolve(directory) === resolve(this.directory)) return false;
    const old = new Store(directory);
    if (await readPrivateFile(old.path) === undefined) return false;
    return this.withLock(() => old.withLock(async () => {
      if (await readPrivateFile(this.path) !== undefined || await readPrivateFile(old.path) === undefined) return false;
      await old.load(); // Validate before moving. Never duplicate a rotating refresh token.
      await rename(old.path, this.path);
      return true;
    }));
  }
}
