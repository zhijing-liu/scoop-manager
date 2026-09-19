/**
 * 通用格式化工具（纯函数，无副作用）。
 */

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / 1024 ** index;
  return `${scaled >= 100 || index === 0 ? Math.round(scaled) : scaled.toFixed(1)} ${units[index]}`;
}

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

export function formatTime(input) {
  if (!input) return '—';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '—';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatClock(input) {
  if (!input) return '—';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '—';
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function fromNow(input) {
  if (!input) return '—';
  const then = new Date(input).getTime();
  if (!Number.isFinite(then)) return '—';
  const diff = Date.now() - then;
  if (diff < 0) return formatTime(input);
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return '刚刚';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return formatTime(input);
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes} 分 ${rest} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

export function formatNumber(input) {
  const value = Number(input);
  if (!Number.isFinite(value)) return '0';
  return value.toLocaleString('zh-CN');
}

/** 任务状态 -> 展示信息 */
export const JOB_STATUS_META = {
  queued: { label: '排队中', tone: 'info' },
  running: { label: '执行中', tone: 'info' },
  succeeded: { label: '成功', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  canceled: { label: '已取消', tone: 'muted' },
  timeout: { label: '超时', tone: 'warn' },
};

export function jobStatusMeta(status) {
  return JOB_STATUS_META[status] ?? { label: status ?? '未知', tone: 'muted' };
}

/** 任务类型 -> 中文标签 */
export const JOB_KIND_LABEL = {
  'scoop.install': '安装 Scoop',
  'scoop.update': '更新 Scoop',
  'scoop.checkup': '环境体检',
  'scoop.export': '导出',
  'scoop.import': '导入',
  'app.install': '安装应用',
  'app.uninstall': '卸载应用',
  'app.update': '更新应用',
  'app.hold': '锁定',
  'app.unhold': '解锁',
  'app.cleanup': '清理旧版本',
  'app.reset': '重置应用',
  'bucket.add': '添加 Bucket',
  'bucket.remove': '删除 Bucket',
  'bucket.update': '更新 Bucket',
  'config.set': '修改配置',
  'config.remove': '删除配置',
  'cache.remove': '清理缓存',
  'script.run': '脚本',
};

export function jobKindLabel(kind) {
  return JOB_KIND_LABEL[kind] ?? kind ?? '任务';
}

/** 应用/仓库名着色，让列表更有辨识度又不引入随机性 */
export function hashHue(text) {
  let hash = 0;
  const value = String(text ?? '');
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 360;
  }
  return hash;
}
