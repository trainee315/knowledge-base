import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';

// 仓库工作树与备份检查共用；不输出秘密值、匹配片段、请求头或错误正文。
const EXCLUDED = new Set(['.git', 'node_modules']);
export async function scanForSecret(secret, roots, extraFiles = []) {
  if (typeof secret !== 'string' || !secret.length) throw new Error('Secret scanner requires a nonempty in-memory credential');
  const needle = Buffer.from(secret);
  const matches = [];
  let files = 0;
  const inspect = async (path, label) => {
    const data = await readFile(path); files++;
    const safeLabel = label.replaceAll(secret, '[REDACTED]');
    if (data.includes(needle)) matches.push({ path: safeLabel, encoding: 'raw' });
    try {
      const value = JSON.parse(data.toString('utf8'));
      for (const entry of Array.isArray(value?.entries) ? value.entries : []) {
        if (typeof entry.content === 'string' && Buffer.from(entry.content, 'base64').includes(needle)) matches.push({ path: safeLabel, encoding: 'backup-entry' });
      }
    } catch { /* 非JSON文件仍完成了逐字节检查。 */ }
  };
  for (const root of roots) {
    const walk = async (directory) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (EXCLUDED.has(entry.name) || entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await walk(path);
        else if (entry.isFile()) await inspect(path, relative(root, path));
      }
    };
    if ((await stat(root)).isDirectory()) await walk(root); else await inspect(root, basename(root));
  }
  for (const file of extraFiles) await inspect(file, basename(file));
  return { passed: matches.length === 0, filesScanned: files, matches, excludedDirectories: [...EXCLUDED] };
}
