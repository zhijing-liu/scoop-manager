/**
 * 视图 2：已安装应用。
 *
 * 数据来自后端的文件系统扫描（毫秒级），因此可以放心地在每次进入页面时刷新。
 * 「可更新」判定复用概览接口的比对结果，不额外调用 scoop status。
 */

import { api, errorMessage } from '../api.js';
import { fromNow, formatTime } from '../format.js';

export function createInstalled(shell) {
  // 详情请求序号：快速连点两个应用时，先发出的请求可能后返回，
  // 会把后点应用的详情覆盖掉。用自增序号丢弃过期响应。
  let detailSeq = 0;

  return {
    items: [],
    loading: false,
    error: '',
    query: '',
    scope: 'all',
    /** 只看可更新：与「用户 / 全局」正交，因此做成独立开关而不是分段项 */
    onlyUpdatable: false,
    sort: 'name',
    /** 「排序」下拉的选项（自绘下拉） */
    sortOptions: [
      { value: 'name', label: '按名称' },
      { value: 'updated', label: '按更新时间' },
      { value: 'bucket', label: '按来源 Bucket' },
    ],
    density: 'comfortable',
    selected: [],
    batchBusy: false,
    /** 正在提交单行操作的应用名：用于禁用该行按钮，避免连点提交重复任务 */
    busyName: '',
    /** 正在提交 `scoop list` 任务 */
    rawListBusy: false,
    detail: {
      open: false,
      loading: false,
      name: '',
      app: null,
      manifest: null,
      available: [],
      error: '',
      showRaw: false,
    },

    /**
     * 加载已安装列表。
     * @param {boolean} force   强制后端重读磁盘（绕过快照缓存），对应「重新扫描」
     * @param {boolean} silent  静默后台刷新：不清空列表、不显示加载态（任务完成后用）
     */
    async load(force = false, silent = false) {
      if (force && !silent) this.items = [];
      if (!silent) this.loading = true;
      this.error = '';
      try {
        const data = await api.get(force ? '/apps?force=1' : '/apps');
        this.items = data.items ?? [];
        // 选中项按 key 收敛：应用被卸载 / 换了范围后要自动从选中集合里移除
        const alive = new Set(this.items.map((item) => this.selectionKey(item)));
        this.selected = this.selected.filter((key) => alive.has(key));
        if (!shell.counts || (shell.updates?.length ?? 0) === 0) {
          // 保证「可更新」角标可用
          await shell.refreshAll({ silentOnboarding: true });
        }
      } catch (error) {
        this.error = errorMessage(error);
      } finally {
        if (!silent) this.loading = false;
      }
    },

    get updatableNames() {
      return new Set((shell.updates ?? []).map((item) => item.name));
    },

    /** 可更新应用总数，用于筛选按钮上的计数 */
    get updatableCount() {
      return (shell.updates ?? []).length;
    },

    /** 当前筛选条件是否生效（空状态里据此提示可一键清空） */
    get hasActiveFilter() {
      return Boolean(this.query.trim()) || this.scope !== 'all' || this.onlyUpdatable;
    },

    clearFilters() {
      this.query = '';
      this.scope = 'all';
      this.onlyUpdatable = false;
    },

    get filtered() {
      const keyword = this.query.trim().toLowerCase();
      let list = this.items;

      if (this.scope === 'user') list = list.filter((item) => !item.global);
      else if (this.scope === 'global') list = list.filter((item) => item.global);

      if (this.onlyUpdatable) {
        const updatable = this.updatableNames;
        list = list.filter((item) => updatable.has(item.name));
      }

      if (keyword) {
        list = list.filter(
          (item) =>
            item.name.toLowerCase().includes(keyword) ||
            (item.description ?? '').toLowerCase().includes(keyword) ||
            (item.bucket ?? '').toLowerCase().includes(keyword),
        );
      }

      const sorted = [...list];
      if (this.sort === 'updated') sorted.sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt) || 0);
      else if (this.sort === 'bucket') sorted.sort((a, b) => (a.bucket ?? '~').localeCompare(b.bucket ?? '~') || a.name.localeCompare(b.name));
      else sorted.sort((a, b) => a.name.localeCompare(b.name));
      return sorted;
    },

    /**
     * 选中项的稳定 key。
     *
     * 同名应用可以同时以「用户」和「全局」两种范围安装（表格行 key 也是按范围区分的），
     * 只用名称作 key 会让两条记录互相串选。
     */
    selectionKey(app) {
      return `${app.name}${app.global ? '#global' : ''}`;
    },

    /** 当前筛选结果里被选中的应用对象（带 global，供批量操作按范围分组） */
    get selectedInView() {
      return this.filtered.filter((item) => this.selected.includes(this.selectionKey(item)));
    },

    get allSelected() {
      const visible = this.filtered;
      return visible.length > 0 && visible.every((item) => this.selected.includes(this.selectionKey(item)));
    },

    get userCount() {
      return this.items.filter((item) => !item.global).length;
    },

    get globalCount() {
      return this.items.filter((item) => item.global).length;
    },

    // ---------------------------------------------------------------- 选择

    isSelected(app) {
      return this.selected.includes(this.selectionKey(app));
    },

    toggleSelect(app) {
      const key = this.selectionKey(app);
      const index = this.selected.indexOf(key);
      if (index >= 0) this.selected.splice(index, 1);
      else this.selected.push(key);
    },

    toggleSelectAll() {
      if (this.allSelected) {
        const visible = new Set(this.filtered.map((item) => this.selectionKey(item)));
        this.selected = this.selected.filter((key) => !visible.has(key));
      } else {
        const merged = new Set(this.selected);
        this.filtered.forEach((item) => merged.add(this.selectionKey(item)));
        this.selected = [...merged];
      }
    },

    clearSelection() {
      this.selected = [];
    },

    // ---------------------------------------------------------------- 批量

    async batchUpdate() {
      const entries = this.selectedInView;
      if (entries.length === 0) return;
      this.batchBusy = true;
      try {
        // 选中项可能同时跨越「用户 / 全局」，按范围拆开提交（见 shell.submitScopedBatches）
        await shell.submitScopedBatches('/apps/update', entries);
        this.clearSelection();
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.batchBusy = false;
      }
    },

    /**
     * 检查更新状态：真实执行 scoop status（联网获取权威结果）。
     * 任务成功后由任务完成回调（jobs.js → refreshAll）自动刷新「可更新」列表。
     */
    statusBusy: false,
    async checkStatus() {
      if (this.statusBusy) return;
      this.statusBusy = true;
      try {
        const data = await api.post('/apps/status');
        shell.trackJob(data.job, { stay: true });
        shell.toast('已开始检查更新状态，完成后列表将自动刷新。', 'info');
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.statusBusy = false;
      }
    },

    async batchUninstall() {
      const entries = this.selectedInView;
      if (entries.length === 0) return;
      const names = entries.map((item) => item.name);
      const confirmed = await shell.askConfirm({
        title: '批量卸载',
        message: `将卸载选中的 ${names.length} 个应用：${names.slice(0, 8).join('、')}${names.length > 8 ? ' 等' : ''}。`,
        detail: '卸载后可通过「搜索与安装」重新安装。',
        confirmText: '卸载',
        danger: true,
      });
      if (!confirmed) return;
      this.batchBusy = true;
      try {
        // 同 batchUpdate：按范围拆开提交，全局应用需要 -g 才能被命中
        await shell.submitScopedBatches('/apps/uninstall', entries);
        this.clearSelection();
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.batchBusy = false;
      }
    },

    // ---------------------------------------------------------------- 单行操作

    /** 单应用更新 —— 展开式高级选项 */
    async update(app, options = {}) {
      this.busyName = app.name;
      try {
        const data = await api.post('/apps/update', {
          apps: [app.name],
          global: app.global,
          // 透传高级选项，默认全部关闭（保持原来的行为）
          force: !!options.force,
          independent: !!options.independent,
          noCache: !!options.noCache,
          skipHash: !!options.skipHash,
          quiet: !!options.quiet,
        });
        // 提交任务会跳到任务页，而抽屉是盖在主内容之上的独立层：
        // 不先关掉，它会一直糊在实时日志上面。
        this.closeDetail();
        shell.trackJob(data.job);
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.busyName = '';
      }
    },

    async uninstall(app) {
      const confirmed = await shell.askConfirm({
        title: `卸载 ${app.name}`,
        message: `将卸载 ${app.name}${app.version ? ` v${app.version}` : ''}。`,
        detail: '如果该应用被其他应用依赖，可能导致依赖它的程序无法运行。',
        confirmText: '卸载',
        danger: true,
      });
      if (!confirmed) return;
      this.busyName = app.name;
      try {
        const data = await api.post('/apps/uninstall', { apps: [app.name], global: app.global, purge: true });
        this.closeDetail();
        shell.trackJob(data.job);
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.busyName = '';
      }
    },

    async toggleHold(app) {
      this.busyName = app.name;
      try {
        const data = await api.post('/apps/hold', { apps: [app.name], hold: !app.hold, global: app.global });
        shell.trackJob(data.job, {
          stay: true,
          onDone: () => {
            // 抽屉里的「锁定状态」用的是打开时抓取的快照，与列表不是同一份数据。
            // 任务结束后不回源刷新，抽屉会一直停在乐观更新前的旧状态。
            if (this.detail.open && this.detail.name === app.name) void this.openDetail(app);
          },
        });
        shell.toast(app.hold ? `已解除锁定 ${app.name}` : `已锁定 ${app.name}`, 'success');
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.busyName = '';
      }
    },

    async reset(app) {
      const confirmed = await shell.askConfirm({
        title: `重置 ${app.name}`,
        message: '重置会重建 shim 与链接，用于解决命令冲突或快捷方式失效的问题。',
        confirmText: '重置',
        danger: false,
      });
      if (!confirmed) return;
      this.busyName = app.name;
      try {
        const data = await api.post('/apps/reset', { apps: [app.name] });
        shell.trackJob(data.job, { stay: true });
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.busyName = '';
      }
    },

    // ---------------------------------------------------------------- 详情抽屉

    async openDetail(app) {
      const seq = ++detailSeq;
      this.detail = {
        open: true,
        loading: true,
        name: app.name,
        app,
        manifest: null,
        available: [],
        error: '',
        showRaw: false,
      };
      try {
        const data = await api.get(`/apps/${encodeURIComponent(app.name)}`);
        if (seq !== detailSeq) return;
        this.detail.app = data.installed ?? app;
        this.detail.manifest = data.manifest ?? null;
        this.detail.available = data.available ?? [];
      } catch (error) {
        if (seq !== detailSeq) return;
        this.detail.error = errorMessage(error);
      } finally {
        if (seq === detailSeq) this.detail.loading = false;
      }
    },

    closeDetail() {
      // 让仍在路上的详情请求作废，避免它回来后又把内容填进已关闭的抽屉
      detailSeq += 1;
      if (this.detail.open) this.detail = { ...this.detail, open: false };
    },

    /**
     * 打开应用主页（等价于 `scoop home <app>` 的效果，但不需要再起一个进程）。
     *
     * 主页地址来自本地 bucket 的 manifest（第三方内容），
     * 因此这里交给 shell.openExternal 统一做 http(s) 过滤与桌面端适配。
     */
    openHomepage(app) {
      const target = app ?? this.detail.app;
      if (!shell.openExternal(target?.homepage)) {
        shell.toast('该应用没有可用的主页地址。', 'info');
      }
    },

    /**
     * 执行 `scoop list`，把 Scoop 自己输出的清单原样打到任务日志。
     *
     * 界面上的清单是本程序扫目录得来的，这个入口用于和上游输出对照，
     * 排查"外部命令改过之后两边对不上"的问题。
     */
    async showRawList() {
      if (this.rawListBusy) return;
      this.rawListBusy = true;
      try {
        const data = await api.post('/apps/list', {});
        // 不传 stay：输出就在任务日志里，直接把用户带到任务页
        shell.trackJob(data.job);
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.rawListBusy = false;
      }
    },

    get detailJson() {
      if (!this.detail.manifest) return '';
      try {
        return JSON.stringify(this.detail.manifest, null, 2);
      } catch {
        return '';
      }
    },

    relative(ts) {
      return fromNow(ts);
    },

    absolute(ts) {
      return formatTime(ts);
    },
  };
}
