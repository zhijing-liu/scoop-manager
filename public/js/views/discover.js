/**
 * 视图 3：搜索与安装。
 *
 * 搜索完全基于后端的内存索引（本地 bucket manifest），因此可以做到输入即搜。
 * 安装前会拉取依赖树，让用户明确知道"装一个会带来什么"。
 */

import { api, errorMessage } from '../api.js';
import { formatNumber } from '../format.js';

export function createDiscover(shell) {
  // 请求序号：输入即搜（debounce）与"连点两个应用"都可能让先发的请求后返回，
  // 用序号丢弃过期响应，避免旧结果覆盖新结果。
  let searchSeq = 0;
  let panelSeq = 0;

  return {
    query: '',
    bucket: '',
    loading: false,
    searching: false,
    error: '',
    results: [],
    total: 0,
    took: 0,
    indexStats: null,
    bucketsList: [],
    /** 已安装应用名（小写），用于在搜索结果里标注「已安装」 */
    installedNames: [],

    /** 「来源 Bucket」下拉的选项：列表是动态的，因此做成 getter 保持响应式 */
    get bucketOptions() {
      return [{ value: '', label: '全部' }, ...this.bucketsList.map((name) => ({ value: name, label: name }))];
    },

    /**
     * 安装命令定义，来自后端 `GET /api/scoop/options`（`scoop-core/options.ts` 是唯一数据源）。
     * 面板渲染、默认值与「将执行的命令」预览全部由它推导，
     * 前端不再手写一份选项列表 —— 否则后端改了短选项，界面上的预览仍会是旧的。
     */
    installDef: null,
    refreshingIndex: false,
    searched: false,

    /** 安装选项定义（boolean 渲染成开关，select 渲染成自绘下拉） */
    get optionDefs() {
      return this.installDef?.options ?? [];
    },

    /** 面板用：按类型分组，模板直接 x-for 渲染（顺序与注册表一致） */
    get booleanOptionDefs() {
      return this.optionDefs.filter((opt) => opt.type === 'boolean');
    },

    get selectOptionDefs() {
      return this.optionDefs.filter((opt) => opt.type === 'select');
    },

    /** 选项的短选项展示（-g / --global） */
    flagLabel(opt) {
      if (!opt) return '';
      if (opt.short) return `-${opt.short}`;
      if (opt.long) return `--${opt.long}`;
      return '';
    },

    /** 按注册表默认值构造一份全新的 options，保证 payload 字段与后端一一对应 */
    defaultOptions() {
      const options = {};
      for (const opt of this.optionDefs) {
        options[opt.key] = opt.type === 'boolean' ? opt.default === true : typeof opt.default === 'string' ? opt.default : '';
      }
      return options;
    },

    panel: {
      open: false,
      app: null,
      deps: [],
      depsLoading: false,
      error: '',
      // 在 openInstallPanel 里按注册表默认值重建
      options: {},
    },

    async load() {
      this.loading = this.results.length === 0;
      this.error = '';
      try {
        await Promise.all([this.loadBuckets(), this.ensureIndex(), this.loadInstalledNames(), this.loadOptionDefs()]);
        if (this.searched && this.query.trim().length >= 1) await this.search();
      } catch (error) {
        this.error = errorMessage(error);
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.loading = false;
      }
    },

    /** 拉取安装命令定义（失败不影响搜索，退化成"无选项"，后端按默认值处理） */
    async loadOptionDefs() {
      try {
        const defs = await api.get('/scoop/options');
        this.installDef = Array.isArray(defs) ? defs.find((item) => item.key === 'install') ?? null : null;
      } catch {
        this.installDef = null;
      }
    },

    /** 已安装清单：搜索结果里标注「已安装」用（失败不影响搜索本身） */
    async loadInstalledNames() {
      try {
        const data = await api.get('/apps');
        this.installedNames = Array.isArray(data.items)
          ? data.items.map((item) => String(item?.name ?? '').toLowerCase())
          : [];
      } catch {
        this.installedNames = [];
      }
    },

    async loadBuckets() {
      try {
        const data = await api.get('/buckets');
        this.bucketsList = Array.isArray(data.items) ? data.items.map((item) => item?.name ?? '').filter(Boolean) : [];
      } catch {
        // bucket 列表失败不影响搜索
      }
    },

    async ensureIndex() {
      try {
        this.indexStats = await api.get('/search/index');
      } catch (error) {
        this.error = errorMessage(error);
        shell.toast(errorMessage(error), 'danger');
      }
    },

    async refreshIndex() {
      this.refreshingIndex = true;
      try {
        this.indexStats = await api.post('/search/index/refresh');
        shell.toast(`索引已重建：${formatNumber(this.indexStats.entries)} 个应用，耗时 ${this.indexStats.took}ms`, 'success');
        if (this.query.trim()) await this.search();
        await shell.refreshAll({ silentOnboarding: true });
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.refreshingIndex = false;
      }
    },

    async search() {
      const seq = ++searchSeq;
      const keyword = this.query.trim();
      this.searched = true;
      this.searching = true;
      try {
        const params = new URLSearchParams();
        params.set('q', keyword);
        if (this.bucket) params.set('bucket', this.bucket);
        params.set('limit', '80');
        const data = await api.get(`/search?${params.toString()}`);
        if (seq !== searchSeq) return; // 已经有更新的搜索发出，丢弃这批过期结果
        this.results = Array.isArray(data.items) ? data.items : [];
        this.total = data.total ?? 0;
        this.took = data.took ?? 0;
        this.indexStats = data.index ?? this.indexStats;
        if (Array.isArray(data.buckets) && data.buckets.length > 0) {
          this.bucketsList = data.buckets;
        }
      } catch (error) {
        if (seq !== searchSeq) return;
        shell.toast(errorMessage(error), 'danger');
      } finally {
        if (seq === searchSeq) this.searching = false;
      }
    },

    clearQuery() {
      this.query = '';
      this.results = [];
      this.total = 0;
      this.searched = false;
      document.getElementById('discover-input')?.focus();
    },

    clearBucket() {
      this.bucket = '';
      if (this.query.trim()) void this.search();
    },

    isInstalled(name) {
      return this.installedNames.includes(String(name ?? '').toLowerCase());
    },

    get indexReady() {
      return (this.indexStats?.entries ?? 0) > 0;
    },

    get emptyReason() {
      if (!this.indexReady) return 'no-index';
      if (!this.searched) return 'idle';
      return this.total === 0 ? 'no-result' : '';
    },

    goBuckets() {
      shell.setView('buckets');
    },

    // ---------------------------------------------------------------- 安装面板

    async openInstallPanel(app) {
      const seq = ++panelSeq;
      this.panel = {
        open: true,
        app,
        deps: [],
        depsLoading: true,
        error: '',
        // 每打开一个应用都重置选项，避免不同应用之间残留状态
        options: this.defaultOptions(),
      };
      try {
        const data = await api.get(`/search/app/${encodeURIComponent(app.name)}`);
        // 快速切换两个应用时，前一次的依赖响应可能后到并把新面板的依赖覆盖掉
        if (seq !== panelSeq) return;
        this.panel.deps = Array.isArray(data.dependencies) ? data.dependencies : [];
      } catch (error) {
        if (seq !== panelSeq) return;
        this.panel.error = errorMessage(error);
      } finally {
        if (seq === panelSeq) this.panel.depsLoading = false;
      }
    },

    closeInstallPanel() {
      // 让仍在路上的依赖请求作废
      panelSeq += 1;
      if (this.panel.open) this.panel = { ...this.panel, open: false };
    },

    async confirmInstall() {
      const app = this.panel.app;
      if (!app) return;
      try {
        const payload = { apps: [app.name], ...this.panel.options };
        if (!payload.arch) delete payload.arch;
        const data = await api.post('/apps/install', payload);
        this.closeInstallPanel();
        shell.trackJob(data.job);
      } catch (error) {
        this.panel.error = errorMessage(error);
        shell.toast(errorMessage(error), 'danger');
      }
    },

    get missingDeps() {
      return this.panel.deps.filter((item) => item.missing);
    },

    /**
     * 根据当前 options 生成"将执行的命令"预览（纯字符串，不调用后端）。
     * 规则与后端 buildFlags() 完全一致：boolean 仅在 true 时出 flag，
     * select 仅在值为非空字符串时输出 `flag value`。
     */
    get installCommandPreview() {
      const app = this.panel.app ? this.panel.app.name : '<app>';
      if (!this.installDef) return `scoop install ${app}`;
      const flags = [];
      for (const opt of this.optionDefs) {
        const value = this.panel.options[opt.key];
        if (opt.type === 'boolean') {
          if (value === true) flags.push(this.flagLabel(opt));
        } else if (typeof value === 'string' && value.length > 0) {
          flags.push(this.flagLabel(opt), value);
        }
      }
      return ['scoop', this.installDef.literal || 'install', ...flags, app].filter(Boolean).join(' ');
    },
  };
}
