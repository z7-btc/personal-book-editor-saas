/**
 * 文件系统小工具：原子写、JSON 读写、目录操作、睡眠。
 * 「每个 chunk 完成立即保存」全部走这里，保证崩溃后文件不会半截。
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** 原子写文件：先写 .tmp 再 rename（同目录 rename 在 Windows 上也是原子的）。 */
export async function writeFileAtomic(file, data) {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  await fs.writeFile(tmp, data);
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    // Windows: 目标被占用时 rename 可能失败，退化为 copy+unlink
    if (err && (err.code === 'EPERM' || err.code === 'EEXIST')) {
      await fs.writeFile(file, data);
      await fs.rm(tmp, { force: true });
    } else {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }
}

export async function writeJson(file, value) {
  await writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export async function readJson(file, fallback = null) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback;
    if (err instanceof SyntaxError) {
      throw new Error(`JSON 解析失败: ${file} - ${err.message}`);
    }
    throw err;
  }
}

export async function readJsonIfExists(file) {
  return readJson(file, null);
}

export async function readText(file) {
  return fs.readFile(file, 'utf8');
}

export async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function listDirs(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function removeDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 将文件系统路径转为 POSIX 风格（EPUB 内部路径始终用 /）。 */
export function toPosix(p) {
  return p.split(path.sep).join('/');
}
