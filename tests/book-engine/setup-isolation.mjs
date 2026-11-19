/**
 * 测试启动前的准备：准备一个干净的临时配置目录，并把它通过
 * PBE_CONFIG_DIR 告诉所有测试。
 *
 * 为什么需要这一步：配置读写默认落在项目真实的 config/ 上。
 * 测试如果直接写那里，就会覆盖用户实际使用的 Provider / API Key。
 * 这个文件由 package.json 的 test 脚本用 --import 预先加载，
 * 保证在任何测试模块 import 之前环境变量已经就位。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-test-config-'));
process.env.PBE_CONFIG_DIR = dir;

/**
 * 账号数据同理：默认落在 `<cwd>/data`，也就是项目里真实的那份。
 * 启动恢复之类的代码会去读 users.json，测试不应该看到开发者本机的账号目录。
 */
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbe-test-data-'));
process.env.PBE_DATA_DIR = dataDir;

// 进程退出时清掉临时目录
process.on('exit', () => {
  for (const d of [dir, dataDir]) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
});
