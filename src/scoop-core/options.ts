/**
 * Scoop 命令参数注册表。
 *
 * 单一数据源：后端用它组装 argv，前端用它渲染语义化选项面板、
 * 生成"将执行的命令"预览。前端通过 `/api/scoop/options` 端点读取。
 *
 * 每个选项的 `short` 必须与 Scoop 官方 getopt 短选项一致，
 * 否则直接导致命令失败（P0 bug 就是 -n vs -k 的教训）。
 */

export type OptionType = 'boolean' | 'select';

export interface OptionChoice {
  value: string;
  label: string;
}

export interface ScoopOption {
  /** 前端 JSON 字段名（camelCase） */
  key: string;
  /** 短选项（单字母，不含连字符）；null 表示只有长选项 */
  short: string | null;
  /** 长选项（不含连字符）；null 表示只有短选项 */
  long: string | null;
  /** 给用户看的中文标签（简短） */
  label: string;
  /** 完整描述，用于 tooltip 或说明文字 */
  description: string;
  type: OptionType;
  /** select 类型的可选项 */
  choices?: OptionChoice[];
  /** 默认值（boolean 用 false） */
  default?: boolean | string | null;
}

export interface ScoopCommandDef {
  key: string;
  name: string;
  /** 命令说明 */
  summary: string;
  /** 命令字面，用于预览（例如 "install" / "update"） */
  literal: string;
  options: ScoopOption[];
  /** 多 app 用什么连接（一般就是空格） */
  separator?: string;
}

// -------------------------------------------------------------------------- install

export const INSTALL: ScoopCommandDef = {
  key: 'install',
  name: '安装应用',
  summary: '安装指定的应用到本机 Scoop 目录',
  literal: 'install',
  options: [
    { key: 'global', short: 'g', long: 'global', label: '全局安装', description: '安装到 SCOOP_GLOBAL 目录，需要管理员权限', type: 'boolean', default: false },
    { key: 'independent', short: 'i', long: 'independent', label: '独立安装', description: '不共享依赖，把所有依赖单独装一份', type: 'boolean', default: false },
    { key: 'noCache', short: 'k', long: 'no-cache', label: '跳过缓存', description: '强制重新下载，不使用本地下载缓存', type: 'boolean', default: false },
    { key: 'skipHash', short: 's', long: 'skip-hash-check', label: '跳过哈希校验', description: '有安全风险，仅在 manifest 哈希失效时临时使用', type: 'boolean', default: false },
    { key: 'noUpdateScoop', short: 'u', long: 'no-update-scoop', label: '不自动更新 Scoop', description: 'Scoop 过时时默认会先 self-update 再安装，勾选后跳过这一步', type: 'boolean', default: false },
    {
      key: 'arch',
      short: 'a',
      long: 'arch',
      label: '指定架构',
      description: '强制使用特定架构（仅当 manifest 支持多架构时有效）',
      type: 'select',
      default: '',
      choices: [
        { value: '', label: '自动（推荐）' },
        { value: '64bit', label: '64bit' },
        { value: '32bit', label: '32bit' },
        { value: 'arm64', label: 'arm64' },
      ],
    },
  ],
};

// -------------------------------------------------------------------------- update

export const UPDATE: ScoopCommandDef = {
  key: 'update',
  name: '更新应用',
  summary: '把指定应用更新到最新版本',
  literal: 'update',
  options: [
    { key: 'global', short: 'g', long: 'global', label: '全局应用', description: '更新全局目录的应用', type: 'boolean', default: false },
    { key: 'force', short: 'f', long: 'force', label: '强制更新', description: '即使没有新版本也重新安装', type: 'boolean', default: false },
    { key: 'independent', short: 'i', long: 'independent', label: '独立更新', description: '不自动安装缺失的依赖', type: 'boolean', default: false },
    { key: 'noCache', short: 'k', long: 'no-cache', label: '跳过缓存', description: '强制重新下载，不使用本地下载缓存', type: 'boolean', default: false },
    { key: 'skipHash', short: 's', long: 'skip-hash-check', label: '跳过哈希校验', description: '有安全风险，仅在 manifest 哈希失效时临时使用', type: 'boolean', default: false },
    { key: 'quiet', short: 'q', long: 'quiet', label: '安静模式', description: '隐藏额外的提示信息', type: 'boolean', default: false },
  ],
};

// -------------------------------------------------------------------------- uninstall

export const UNINSTALL: ScoopCommandDef = {
  key: 'uninstall',
  name: '卸载应用',
  summary: '卸载指定的应用，保留版本目录',
  literal: 'uninstall',
  options: [
    { key: 'global', short: 'g', long: 'global', label: '全局应用', description: '卸载全局目录的应用', type: 'boolean', default: false },
    { key: 'purge', short: 'p', long: 'purge', label: '彻底清理', description: '同时删除 persistent 目录中的用户数据（不可恢复）', type: 'boolean', default: false },
  ],
};

// -------------------------------------------------------------------------- hold

export const HOLD: ScoopCommandDef = {
  key: 'hold',
  name: '锁定/解锁应用',
  summary: 'hold 禁止更新，unhold 恢复更新',
  literal: 'hold',
  options: [
    { key: 'global', short: 'g', long: 'global', label: '全局应用', description: '锁定全局目录的应用', type: 'boolean', default: false },
  ],
};

// -------------------------------------------------------------------------- cleanup

export const CLEANUP: ScoopCommandDef = {
  key: 'cleanup',
  name: '清理旧版本',
  summary: '删除已安装应用的旧版本目录',
  literal: 'cleanup',
  options: [
    { key: 'global', short: 'g', long: 'global', label: '全局应用', description: '清理全局目录的应用', type: 'boolean', default: false },
    { key: 'cache', short: 'k', long: 'cache', label: '同时清理过期下载缓存', description: '除了旧版本外，也删除不再被任何已安装应用引用的下载缓存', type: 'boolean', default: false },
  ],
};

// -------------------------------------------------------------------------- reset

export const RESET: ScoopCommandDef = {
  key: 'reset',
  name: '重置应用',
  summary: '重建 shim 与 current 链接，用于解决命令冲突或快捷方式失效',
  literal: 'reset',
  options: [],
};

// -------------------------------------------------------------------------- cache rm

export const CACHE_RM: ScoopCommandDef = {
  key: 'cache-rm',
  name: '清理下载缓存',
  summary: '从 scoop cache 目录删除指定文件或全部文件',
  literal: 'cache rm',
  options: [],
};

// -------------------------------------------------------------------------- download

export const DOWNLOAD: ScoopCommandDef = {
  key: 'download',
  name: '仅下载（不安装）',
  summary: '下载应用到缓存目录并校验哈希，但不执行安装',
  literal: 'download',
  options: [
    { key: 'force', short: 'f', long: 'force', label: '强制覆盖缓存', description: '即使缓存中已有同名文件也重新下载', type: 'boolean', default: false },
    { key: 'skipHash', short: 's', long: 'skip-hash-check', label: '跳过哈希校验', description: '有安全风险，仅在 manifest 哈希失效时临时使用', type: 'boolean', default: false },
    { key: 'noUpdateScoop', short: 'u', long: 'no-update-scoop', label: '不自动更新 Scoop', description: 'Scoop 过时时默认会先 self-update 再下载，勾选后跳过', type: 'boolean', default: false },
    {
      key: 'arch',
      short: 'a',
      long: 'arch',
      label: '指定架构',
      description: '强制使用特定架构（仅当 manifest 支持多架构时有效）',
      type: 'select',
      default: '',
      choices: [
        { value: '', label: '自动（推荐）' },
        { value: '64bit', label: '64bit' },
        { value: '32bit', label: '32bit' },
        { value: 'arm64', label: 'arm64' },
      ],
    },
  ],
};

// -------------------------------------------------------------------------- list

export const LIST: ScoopCommandDef = {
  key: 'list',
  name: '已安装清单',
  summary: '直接输出 Scoop 自己的已安装清单（可带一个筛选词）',
  literal: 'list',
  // `scoop list [query]` 没有任何选项，唯一的参数是可选筛选词
  options: [],
};

// -------------------------------------------------------------------------- 注册表

export const ALL_COMMANDS: Record<string, ScoopCommandDef> = {
  install: INSTALL,
  update: UPDATE,
  uninstall: UNINSTALL,
  hold: HOLD,
  unhold: HOLD, // 同一套参数，只是命令字面不同
  cleanup: CLEANUP,
  reset: RESET,
  'cache-rm': CACHE_RM,
  download: DOWNLOAD,
  list: LIST,
};

/** 获取命令定义（前端 /api/scoop/options 用）。 */
export function getCommandDef(key: string): ScoopCommandDef | undefined {
  return ALL_COMMANDS[key];
}

/** 供前端拉取的快照。 */
export function listCommandDefs(): ScoopCommandDef[] {
  return Object.values(ALL_COMMANDS);
}

// -------------------------------------------------------------------------- 组装 argv

/** 从前端 options 对象生成 argv flags（不含命令字本身和 app 名称）。 */
export function buildFlags(def: ScoopCommandDef, options: Record<string, unknown>): string[] {
  const flags: string[] = [];
  for (const opt of def.options) {
    const value = options[opt.key];
    if (opt.type === 'boolean') {
      if (value === true) {
        if (opt.short) flags.push(`-${opt.short}`);
        else if (opt.long) flags.push(`--${opt.long}`);
      }
    } else if (opt.type === 'select') {
      if (typeof value === 'string' && value.length > 0) {
        if (opt.short) {
          flags.push(`-${opt.short}`, value);
        } else if (opt.long) {
          flags.push(`--${opt.long}`, value);
        }
      }
    }
  }
  return flags;
}

/**
 * 生成"将执行的命令"预览字符串。
 * 用于前端 UI 展示；后端也可用于日志首行。
 */
export function previewCommand(def: ScoopCommandDef, options: Record<string, unknown>, apps: string[] | string): string {
  const appList = Array.isArray(apps) ? apps.join(' ') : apps;
  const flags = buildFlags(def, options);
  const parts = [def.literal, ...flags, appList].filter((p) => p !== '');
  return `scoop ${parts.join(' ')}`.trim();
}
