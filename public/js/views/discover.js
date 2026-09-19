/**
 * 视图 3：搜索与安装。
 *
 * 搜索完全基于后端的内存索引（本地 bucket manifest），因此可以做到输入即搜。
 * 安装前会拉取依赖树，让用户明确知道"装一个会带来什么"。
 */

import { api, errorMessage } from '../api.js';
import { formatNumber } from '../format.js';

export function createDiscover(shell) {
  return {
    query: '',
    bucket: '',
    loading: false,
    searching: false,
    results: [],
    total: 0,
    took: 0,
    indexStats: null,
    bucketsList: [],

    /** 「来源 Bucket」下拉的选项：列表是动态的，因此做成 getter 保持响应式 */
    get bucketOptions() {
      return [{ value: '', label: '全部' }, ...this.bucketsList.map((name) => ({ value: name, label: name }))];
    },

    /** 「指定架构」下拉的选项 */
    archOptions: [
      { value: '', label: '自动（推荐）' },
      { value: '64bit', label: '64bit' },
      { value: '32bit', label: '32bit' },
      { value: 'arm64', label: 'arm64' },
    ],
    refreshingIndex: false,
    searched: false,

    panel: {
      open: false,
      app: null,
      deps: [],
      depsLoading: false,
      error: '',
      options: { global: false, independent: false, skipHash: false, noCache: false, arch: '' },
    },

    async load() {
      this.loading = this.results.length === 0;
      try {
        await Promise.all([this.loadBuckets(), this.ensureIndex()]);
        if (this.searched && this.query.trim().length >= 1) await this.search();
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.loading = false;
      }
    },

    async loadBuckets() {
      try {
        const data = await api.get('/buckets');
        this.bucketsList = (data.items ?? []).map((item) => item.name);
      } catch {
        // bucket 列表失败不影响搜索
      }
    },

    async ensureIndex() {
      try {
        this.indexStats = await api.get('/search/index');
      } catch (error) {
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
      const keyword = this.query.trim();
      this.searched = true;
      this.searching = true;
      try {
        const params = new URLSearchParams();
        params.set('q', keyword);
        if (this.bucket) params.set('bucket', this.bucket);
        params.set('limit', '80');
        const data = await api.get(`/search?${params.toString()}`);
        this.results = data.items ?? [];
        this.total = data.total ?? 0;
        this.took = data.took ?? 0;
        this.indexStats = data.index ?? this.indexStats;
        if (Array.isArray(data.buckets) && data.buckets.length > 0) {
          this.bucketsList = data.buckets;
        }
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.searching = false;
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

    get installedNames() {
      return new Set((shell.counts ? [] : []).concat([]));
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
      this.panel = {
        open: true,
        app,
        deps: [],
        depsLoading: true,
        error: '',
        options: { global: false, independent: false, skipHash: false, noCache: false, arch: '' },
      };
      try {
        const data = await api.get(`/search/app/${encodeURIComponent(app.name)}`);
        this.panel.deps = data.dependencies ?? [];
      } catch (error) {
        this.panel.error = errorMessage(error);
      } finally {
        this.panel.depsLoading = false;
      }
    },

    closeInstallPanel() {
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
  };
}
