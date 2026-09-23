/**
 * 任务日志的「建议」规则表。
 *
 * 存在的意义：Scoop 的日志里有一类**不是失败、但需要人处理**的输出。最典型的是
 * 第三方 bucket 的清单脚本引用了另一个 bucket 的辅助模块：
 *
 *   Import-Module : 未能加载指定的模块"G:\scoop\buckets\dorado\scripts\DoradoUtils.psm1"
 *   Mount-ExternalRuntimeData : 无法将"Mount-ExternalRuntimeData"项识别为 cmdlet...
 *   Remove-Module : 没有删除任何模块。
 *
 * 应用其实装成功了（下载、解压、建快捷方式都完成），只有「挂载用户数据目录」这一步
 * 被跳过 —— 但界面上只看到一片红色 stderr，用户无从判断该不该管、该怎么管。
 * 这里把它翻译成一条带操作的提示。
 *
 * 三个设计约束：
 *   1. **在后端识别**：日志在后端产出、任务摘要本来就要落盘，建议随摘要一起持久化，
 *      刷新页面或重启服务后依然在，不必让前端为了同一条规则再扫一遍日志。
 *   2. **只读日志，不驱动写操作**：建议里只带「动作描述」（打开表单 / 切视图），
 *      真正的写操作仍由用户在界面上确认，避免日志内容直接触发变更。
 *   3. **宁可漏报，不可误报**：规则跑在每一条日志上，误报会给出错误的操作按钮。
 *      因此每条规则都要求足够的上下文（例如必须同时看到「模块加载失败」与
 *      `buckets\<name>\scripts\` 路径），而不是单独匹配某个泛化词。
 */

import type { JobHint } from './types.js';

/** 单个任务最多保留的建议条数：日志有环缓冲，这里也封顶，避免异常输出撑爆摘要 */
export const MAX_HINTS_PER_JOB = 5;

/** 单条建议文案的长度上限（日志内容进过这里，按不可信输入处理） */
const MAX_TEXT = 400;

interface HintRule {
  id: string;
  level: JobHint['level'];
  /** 逐行匹配；捕获组供 build 拼文案 */
  pattern: RegExp;
  build: (match: RegExpExecArray) => Omit<JobHint, 'id' | 'level'>;
}

/** 取路径最后一段（`...\buckets\dorado\scripts\DoradoUtils.psm1` → `DoradoUtils.psm1`） */
function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** 日志文本进过规则，统一裁剪一次再进摘要 */
function clip(text: string): string {
  const value = text.trim();
  return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}…` : value;
}

export const HINT_RULES: HintRule[] = [
  {
    id: 'bucket-helper-missing',
    level: 'warn',
    /**
     * 清单脚本引用了「另一个 bucket」里的辅助模块，而那个 bucket 没装。
     *
     * 为什么必须同时匹配两段：单独匹配 `Import-Module` 会命中任何模块加载问题
     * （包括用户自己改坏的模块），单独匹配 `buckets\...\scripts\` 又会命中
     * 正常的脚本路径输出。只有两者同行出现，才说明是「清单要求一个不存在的 bucket」。
     */
    pattern: /(?:Import-Module|未能加载指定的模块|ModuleNotFound)[^\r\n]*?[\\/]buckets[\\/]([A-Za-z0-9._+-]+)[\\/]scripts[\\/]([^\s"']+)/,
    build: (match) => {
      const bucket = match[1];
      const file = baseName(match[2]);
      return {
        title: `清单脚本依赖的 bucket「${bucket}」没有安装`,
        message: clip(
          `脚本要从 buckets\\${bucket}\\scripts\\ 加载 ${file}，但本地没有名为「${bucket}」的 bucket，` +
            `因此这一步被跳过了（下载与解压通常已经完成，应用可能仍然安装成功）。` +
            `添加同名 bucket 后重新执行一次同样的操作即可补齐。`,
        ),
        action: { kind: 'bucket.add', bucket, label: `添加 Bucket「${bucket}」` },
      };
    },
  },
  {
    id: 'manifest-missing',
    level: 'warn',
    // 例：Couldn't find manifest for 'bilibili'.
    pattern: /Couldn't find manifest for ['"]([^'"]+)['"]/i,
    build: (match) => ({
      title: `找不到「${match[1]}」的清单`,
      message: clip(
        '该应用不在任何已安装的 bucket 里，通常是 bucket 未同步、或应用来自已经被移除的 bucket。' +
          '先在 Bucket 页更新一次；若某个 bucket 已被删除，需要重新添加它。',
      ),
      action: { kind: 'view', view: 'buckets', label: '去 Bucket 页' },
    }),
  },
  {
    id: 'hash-mismatch',
    level: 'warn',
    pattern: /Hash check failed|hash mismatch|哈希校验失败/i,
    build: () => ({
      title: '安装包校验失败（哈希不匹配）',
      message: clip(
        '下载到的文件与清单里记录的哈希不一致。常见原因是缓存里留着上一次没下完/损坏的包，' +
          '或代理、安全软件改写了文件。清空下载缓存后重新执行，下一次会重新下载。',
      ),
      action: { kind: 'view', view: 'dashboard', label: '去概览页清空缓存' },
    }),
  },
  {
    id: 'network-failure',
    level: 'info',
    pattern:
      /ERROR\s+Download failed|Connection was reset|Unable to connect to the remote server|The remote name could not be resolved|underlying connection was closed|无法解析|连接被重置|操作超时/i,
    build: () => ({
      title: '下载或连接失败',
      message: clip(
        '网络请求没能完成。若本机需要通过代理访问外网，请确认「配置与代理」里的地址与端口；' +
          '也可以先在任务列表上点「重试」再试一次。',
      ),
      action: { kind: 'view', view: 'config', label: '去配置代理' },
    }),
  },
  {
    id: 'permission-denied',
    level: 'info',
    pattern: /拒绝访问|Access is denied|UnauthorizedAccessException|requires (?:admin|elevation)/i,
    build: () => ({
      title: '权限不足',
      message: clip(
        '有文件写入被系统拒绝。普通应用不需要管理员权限，反过来用管理员身份运行 scoop 还可能' +
          '改变文件属主、把安装范围弄乱；只有全局安装（-g）才需要提权。请退出管理员窗口后重试。',
      ),
    }),
  },
];

/**
 * 创建一个逐行扫描器。
 *
 * 返回值每命中一条规则就产出该条建议，同一个「规则 + 关键词」只产出一次
 * （去重键进 `id`，前端与持久化都按它判重）。
 *
 * @param initial 已存在的建议（任务从 jobs.json 恢复时传入，避免重复产出）
 */
export function createHintDetector(initial: JobHint[] = []): (line: string) => JobHint | null {
  const seen = new Set(initial.map((hint) => hint.id));
  // 上限是对整个任务而言的，因此已恢复的建议也计入
  let produced = initial.length;
  return function detect(line: string): JobHint | null {
    if (!line || produced >= MAX_HINTS_PER_JOB) return null;
    for (const rule of HINT_RULES) {
      const match = rule.pattern.exec(line);
      if (!match) continue;
      // 捕获组 1 作为关键词（bucket 名 / 应用名），没有捕获组时退化为只按规则去重
      const key = match[1] ? `${rule.id}:${match[1]}` : rule.id;
      if (seen.has(key)) continue;
      seen.add(key);
      produced += 1;
      return { id: key, level: rule.level, ...rule.build(match) };
    }
    return null;
  };
}
