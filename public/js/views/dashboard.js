/**
 * 视图 1：环境概览。
 *
 * 承载"首次进入就要看到结论"的职责：scoop 是否可用、路径在哪、有多少可更新、
 * 以及最常用的四个快捷操作。
 */

import { api, errorMessage } from '../api.js';
import { formatBytes, fromNow, formatNumber } from '../format.js';

/**
 * 导入 Scoopfile 的体积上限。
 * 正常备份只有几十 KB；设上限是为了不把超大文件整个读进内存再 POST，
 * 也避免 sidecar 收到病态大小的请求体。
 */
const SCOOPFILE_MAX_BYTES = 1024 * 1024;

export function createDashboard(shell) {
  return {
    loading: false,
    error: '',
    cache: null,
    checking: false,
    updateBusy: '',

    /**
     * 加载概览页需要的数据。
     * @param {{ silent?: boolean }} options
     *   silent=true 用于后台补刷（只更新缓存体积，不置加载态、不再触发全局刷新），
     *   必须保证这条路径不会反过来调用 refreshAll，否则会和调用方形成死锁。
     */
    async load(options = {}) {
      const silent = options.silent === true;
      if (!silent) this.loading = true;
      this.error = '';
      try {
        // 概览数据已经在 shell 里，这里只补缓存体积这一项（磁盘扫描，单独取）
        this.cache = await api.get('/cache');
        if (!silent && (!shell.env || !shell.counts)) await shell.refreshAll({ silentOnboarding: true });
      } catch (error) {
        this.error = errorMessage(error);
      } finally {
        if (!silent) this.loading = false;
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

    async uninstallScoop() {
      const env = shell.env;
      if (!env || !env.installed) {
        shell.toast('Scoop 尚未安装，无需卸载。', 'info');
        return;
      }
      const confirmed = await shell.askConfirm({
        title: `卸载 Scoop`,
        message: `将调用 scoop uninstall scoop，删除 Scoop 自身与它管理的所有应用目录。`,
        detail: `当前根目录：${env.root}。卸载后本程序会自动重新检测环境。注意：powershell.exe / git 等未被 Scoop 安装的程序不会被删除。`,
        confirmText: '确认卸载',
        danger: true,
      });
      if (!confirmed) return;
      try {
        const data = await shell.runAction(() => api.post('/scoop/uninstall'));
        if (data && data.job) shell.trackJob(data.job);
        else shell.toast(data?.reason || '卸载请求未返回任务。', 'warn');
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      }
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

    /** 触发隐藏的文件选择框（input 在模板里，视图对象拿不到 $refs，只能按 id 取）。 */
    pickScoopfile() {
      const input = document.getElementById('scoopfile-input');
      if (!input) return;
      // 先清空：否则连续选择同一个文件不会再触发 change
      input.value = '';
      input.click();
    },

    /**
     * 读取并导入 Scoopfile。
     *
     * 边界处理：用户取消选择 / 空文件 / 超过体积上限 / 非法 JSON / 不是数组 / 空数组，
     * 全部在提交前拦掉并给出具体原因；读取与提交阶段抛出的异常由外层 catch 兜住。
     */
    async onScoopfilePicked(event) {
      const input = event?.target;
      const file = input?.files && input.files[0];
      if (!file) return; // 用户取消了选择

      try {
        if (file.size === 0) {
          shell.toast('选择的文件是空的。', 'warn');
          return;
        }
        if (file.size > SCOOPFILE_MAX_BYTES) {
          shell.toast(`Scoopfile 过大（${formatBytes(file.size)}），上限 ${formatBytes(SCOOPFILE_MAX_BYTES)}。`, 'danger');
          return;
        }

        const text = await file.text();
        if (!text.trim()) {
          shell.toast('选择的文件内容为空。', 'warn');
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          shell.toast('该文件不是合法的 JSON，无法导入。', 'danger');
          return;
        }
        // 兼容两种形态：scoop export 产出的是 { buckets, apps } 对象，
        // 手写文件则常是纯应用数组。只认数组会拒掉本程序自己导出的文件。
        const appCount = Array.isArray(parsed)
          ? parsed.length
          : Array.isArray(parsed?.apps)
            ? parsed.apps.length
            : -1;
        if (appCount < 0) {
          shell.toast('Scoopfile 格式无法识别：应为应用数组，或包含 apps 数组的对象（与「导出 Scoopfile」的输出一致）。', 'danger', 8000);
          return;
        }
        if (appCount === 0) {
          shell.toast('Scoopfile 里没有任何应用，无需导入。', 'info');
          return;
        }

        const confirmed = await shell.askConfirm({
          title: '导入 Scoopfile',
          message: `将按文件里的 ${formatNumber(appCount)} 项安装应用（已安装的会按 Scoop 的规则跳过或更新）。`,
          detail: `文件：${file.name}（${formatBytes(file.size)}）。导入过程会实时输出日志，可随时取消。`,
          confirmText: '开始导入',
          danger: false,
        });
        if (!confirmed) return;

        const data = await shell.runAction(() => api.post('/scoop/import', { content: text }));
        if (data?.job) shell.trackJob(data.job);
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        // 无论成功失败都清空，保证可以再次选择同一个文件
        if (input) input.value = '';
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
      // 缓存被清空后，概览页的「下载缓存」指标必须回源，否则会一直显示旧体积
      if (data) shell.trackJob(data.job, { onDone: () => void this.load({ silent: true }) });
    },

    async cleanupOldVersions() {
      const confirmed = await shell.askConfirm({
        title: '清理旧版本',
        message: '将删除所有应用的旧版本目录，仅保留当前版本。',
        detail: '同时会删除不再被任何已安装应用引用的下载缓存（scoop cleanup --cache）。',
        confirmText: '开始清理',
        danger: true,
      });
      if (!confirmed) return;
      // 这是唯一的清理入口，直接带上 cache=true：请求本身就把语义表达清楚了。
      const data = await shell.runAction(() => api.post('/cache/cleanup', { apps: [], cache: true }));
      // 旧版本目录与缓存都会变，任务结束后把概览数据拉回来
      if (data) shell.trackJob(data.job, { onDone: () => void this.load({ silent: true }) });
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
      // 必须带上每个应用的安装范围：/apps/update 只接受一个 global 布尔，
      // 混选时会由 submitScopedBatches 拆成两次请求，否则全局应用不会被更新到。
      const entries = this.updates
        .map((item) => ({ name: item.name, global: Boolean(item.global) }))
        .filter((item) => Boolean(item.name));
      if (entries.length === 0) {
        shell.toast('当前没有可更新的应用。', 'info');
        return;
      }
      const globalCount = entries.filter((item) => item.global).length;
      const scopeNote =
        globalCount > 0 && globalCount < entries.length
          ? `其中 ${entries.length - globalCount} 个为用户范围、${globalCount} 个为全局范围，将分两批依次执行。`
          : '';
      const confirmed = await shell.askConfirm({
        title: '更新全部可更新应用',
        message: `将依次更新 ${entries.length} 个应用，耗时可能较长，过程中可随时取消。`,
        detail: scopeNote,
        confirmText: '开始更新',
        danger: false,
      });
      if (!confirmed) return;
      try {
        await shell.submitScopedBatches('/apps/update', entries);
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      }
    },

    statusLabelOf() {
      return shell.env?.installed ? '运行正常' : '待配置';
    },
  };
}
