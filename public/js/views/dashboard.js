/**
 * 视图 1：环境概览。
 *
 * 承载"首次进入就要看到结论"的职责：scoop 是否可用、路径在哪、有多少可更新、
 * 以及最常用的四个快捷操作。
 */

import { api, errorMessage } from '../api.js';
import { formatBytes, fromNow, formatNumber } from '../format.js';

export function createDashboard(shell) {
  return {
    loading: false,
    error: '',
    cache: null,
    checking: false,
    updateBusy: '',

    async load() {
      this.loading = true;
      this.error = '';
      try {
        // 概览数据已经在 shell 里，这里只补缓存体积这一项（磁盘扫描，单独取）
        this.cache = await api.get('/cache');
        if (!shell.env || !shell.counts) await shell.refreshAll({ silentOnboarding: true });
      } catch (error) {
        this.error = errorMessage(error);
      } finally {
        this.loading = false;
      }
    },

    get env() {
      return shell.env;
    },

    get counts() {
      return shell.counts;
    },

    get updates() {
      return shell.updates ?? [];
    },

    get hasUpdates() {
      return (shell.updates?.length ?? 0) > 0;
    },

    get healthChecks() {
      const env = shell.env;
      if (!env) return [];
      const checks = [
        {
          key: 'platform',
          label: '运行平台',
          value: env.supported ? 'Windows' : env.platform,
          ok: env.supported,
          hint: env.supported ? '' : 'Scoop 仅支持 Windows，功能不可用。',
        },
        {
          key: 'installed',
          label: 'Scoop 安装',
          value: env.installed ? '已安装' : '未检测到',
          ok: env.installed,
          hint: env.installed ? '' : '请使用「一键安装」或「指定已有路径」。',
        },
        {
          key: 'root',
          label: 'Scoop 根目录',
          value: env.root ?? '—',
          ok: Boolean(env.root),
          mono: true,
          copy: env.root ?? '',
        },
        {
          key: 'version',
          label: 'Scoop 版本',
          value: env.version ? `${env.version}${env.channel === 'master' ? '（master 通道）' : ''}` : '未知',
          ok: Boolean(env.version),
        },
        {
          key: 'global',
          label: '全局 Scoop 目录',
          value: env.globalRoot ?? '未配置',
          ok: true,
          mono: true,
          copy: env.globalRoot ?? '',
        },
        {
          key: 'powershell',
          label: 'PowerShell',
          value: env.powershell?.kind === 'pwsh' ? 'PowerShell 7 (pwsh)' : env.powershell?.path ? 'Windows PowerShell 5.1' : '未找到',
          ok: Boolean(env.powershell?.path),
          hint: env.powershell?.path ?? '',
          mono: true,
        },
        {
          key: 'policy',
          label: '执行策略',
          value: env.powershell?.executionPolicy ?? '未知',
          ok: Boolean(env.powershell?.executionPolicy),
          hint: '本工具固定使用 -ExecutionPolicy Bypass 调用，无需修改系统设置。',
        },
        {
          key: 'config',
          label: '配置文件',
          value: env.configFile ?? '—',
          ok: Boolean(env.configFile),
          mono: true,
          copy: env.configFile ?? '',
        },
      ];
      return checks;
    },

    get metricCards() {
      const counts = shell.counts ?? {};
      return [
        { key: 'installed', label: '已安装应用', value: formatNumber(counts.installed ?? 0), unit: '个', tone: 'primary', icon: 'box' },
        { key: 'updatable', label: '可更新', value: formatNumber(counts.updatable ?? 0), unit: '个', tone: counts.updatable > 0 ? 'warn' : 'success', icon: 'arrow-up' },
        { key: 'buckets', label: 'Bucket', value: formatNumber(counts.buckets ?? 0), unit: '个', tone: 'accent', icon: 'layers' },
        { key: 'index', label: '可搜索应用', value: formatNumber(counts.indexEntries ?? 0), unit: '个', tone: 'info', icon: 'search' },
        { key: 'cache', label: '下载缓存', value: this.cache ? formatBytes(this.cache.totalBytes) : '—', unit: '', tone: 'muted', icon: 'database' },
        { key: 'held', label: '已锁定', value: formatNumber(counts.held ?? 0), unit: '个', tone: 'muted', icon: 'lock' },
      ];
    },

    get cacheSummary() {
      if (!this.cache) return null;
      return { total: this.cache.totalBytes, entries: this.cache.totalEntries, truncated: this.cache.truncated };
    },

    get cacheSizeLabel() {
      if (!this.cache) return '统计中…';
      return `当前占用 ${formatBytes(this.cache.totalBytes)}`;
    },

    // ---------------------------------------------------------------- 快捷操作

    async checkup() {
      const data = await shell.runAction(() => api.post('/scoop/checkup'));
      if (data) shell.trackJob(data.job);
    },

    async selfUpdate() {
      const data = await shell.runAction(() => api.post('/scoop/self-update'));
      if (data) shell.trackJob(data.job);
    },

    async updateBucket() {
      const data = await shell.runAction(() => api.post('/buckets/update', {}));
      if (data) shell.trackJob(data.job);
    },

    async exportScoopfile() {
      const data = await shell.runAction(() => api.get('/scoop/export'));
      if (!data) return;
      try {
        const blob = new Blob([data.json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'Scoopfile.json';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        shell.toast(`已导出 ${data.appCount} 个应用`, 'success');
      } catch {
        shell.toast('导出文件失败，但内容已生成在服务端数据目录中。', 'warn');
      }
    },

    async clearCache() {
      const confirmed = await shell.askConfirm({
        title: '清空下载缓存',
        message: `将删除缓存目录中的全部内容${this.cache ? `（约 ${formatBytes(this.cache.totalBytes)}）` : ''}，下次安装会重新下载。`,
        confirmText: '清空缓存',
        danger: true,
      });
      if (!confirmed) return;
      const data = await shell.runAction(() => api.post('/cache/remove', {}));
      if (data) shell.trackJob(data.job);
    },

    async cleanupOldVersions() {
      const confirmed = await shell.askConfirm({
        title: '清理旧版本',
        message: '将删除所有应用的旧版本目录，仅保留当前版本。该操作不可撤销。',
        confirmText: '开始清理',
        danger: true,
      });
      if (!confirmed) return;
      const data = await shell.runAction(() => api.post('/cache/cleanup', {}));
      if (data) shell.trackJob(data.job);
    },

    async updateOne(name, global = false) {
      this.updateBusy = name;
      try {
        const data = await api.post('/apps/update', { apps: [name], global });
        shell.trackJob(data.job, { stay: false });
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.updateBusy = '';
      }
    },

    async updateAll() {
      const names = this.updates.map((item) => item.name).filter(Boolean);
      if (names.length === 0) {
        shell.toast('当前没有可更新的应用。', 'info');
        return;
      }
      const confirmed = await shell.askConfirm({
        title: '更新全部可更新应用',
        message: `将依次更新 ${names.length} 个应用，耗时可能较长，过程中可随时取消。`,
        confirmText: '开始更新',
        danger: false,
      });
      if (!confirmed) return;
      const data = await shell.runAction(() => api.post('/apps/update', { apps: names }));
      if (data) shell.trackJob(data.job);
    },

    statusLabelOf() {
      return shell.env?.installed ? '运行正常' : '待配置';
    },
  };
}
