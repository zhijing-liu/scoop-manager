/**
 * 视图 2：已安装应用。
 *
 * 数据来自后端的文件系统扫描（毫秒级），因此可以放心地在每次进入页面时刷新。
 * 「可更新」判定复用概览接口的比对结果，不额外调用 scoop status。
 */

import { api, errorMessage } from '../api.js';
import { fromNow, formatTime } from '../format.js';

export function createInstalled(shell) {
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

    async load(force = false) {
      if (force) this.items = [];
      this.loading = true;
      this.error = '';
      try {
        const data = await api.get('/apps');
        this.items = data.items ?? [];
        this.selected = this.selected.filter((name) => this.items.some((item) => item.name === name));
        if (!shell.counts || (shell.updates?.length ?? 0) === 0) {
          // 保证「可更新」角标可用
          await shell.refreshAll({ silentOnboarding: true });
        }
      } catch (error) {
        this.error = errorMessage(error);
      } finally {
        this.loading = false;
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
      if (this.sort === 'updated') sorted.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      else if (this.sort === 'bucket') sorted.sort((a, b) => (a.bucket ?? '~').localeCompare(b.bucket ?? '~') || a.name.localeCompare(b.name));
      else sorted.sort((a, b) => a.name.localeCompare(b.name));
      return sorted;
    },

    get selectedInView() {
      const visible = new Set(this.filtered.map((item) => item.name));
      return this.selected.filter((name) => visible.has(name));
    },

    get allSelected() {
      const visible = this.filtered;
      return visible.length > 0 && visible.every((item) => this.selected.includes(item.name));
    },

    get userCount() {
      return this.items.filter((item) => !item.global).length;
    },

    get globalCount() {
      return this.items.filter((item) => item.global).length;
    },

    // ---------------------------------------------------------------- 选择

    isSelected(name) {
      return this.selected.includes(name);
    },

    toggleSelect(name) {
      const index = this.selected.indexOf(name);
      if (index >= 0) this.selected.splice(index, 1);
      else this.selected.push(name);
    },

    toggleSelectAll() {
      if (this.allSelected) {
        const visible = new Set(this.filtered.map((item) => item.name));
        this.selected = this.selected.filter((name) => !visible.has(name));
      } else {
        const merged = new Set(this.selected);
        this.filtered.forEach((item) => merged.add(item.name));
        this.selected = [...merged];
      }
    },

    clearSelection() {
      this.selected = [];
    },

    // ---------------------------------------------------------------- 批量

    async batchUpdate() {
      const names = this.selectedInView;
      if (names.length === 0) return;
      this.batchBusy = true;
      try {
        const data = await api.post('/apps/update', { apps: names });
        this.clearSelection();
        shell.trackJob(data.job);
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.batchBusy = false;
      }
    },

    async batchUninstall() {
      const names = this.selectedInView;
      if (names.length === 0) return;
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
        const data = await api.post('/apps/uninstall', { apps: names });
        this.clearSelection();
        shell.trackJob(data.job);
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.batchBusy = false;
      }
    },

    // ---------------------------------------------------------------- 单行操作

    async update(app) {
      try {
        const data = await api.post('/apps/update', { apps: [app.name], global: app.global });
        shell.trackJob(data.job);
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      }
    },

    async uninstall(app) {
      const confirmed = await shell.askConfirm({
        title: `卸载 ${app.name}`,
        message: `将卸载 ${app.name} v${app.version}。`,
        detail: '如果该应用被其他应用依赖，可能导致依赖它的程序无法运行。',
        confirmText: '卸载',
        danger: true,
      });
      if (!confirmed) return;
      try {
        const data = await api.post('/apps/uninstall', { apps: [app.name], global: app.global, purge: true });
        shell.trackJob(data.job);
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      }
    },

    async toggleHold(app) {
      try {
        const data = await api.post('/apps/hold', { apps: [app.name], hold: !app.hold, global: app.global });
        shell.trackJob(data.job, { stay: true });
        shell.toast(app.hold ? `已解除锁定 ${app.name}` : `已锁定 ${app.name}`, 'success');
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
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
      try {
        const data = await api.post('/apps/reset', { apps: [app.name] });
        shell.trackJob(data.job, { stay: true });
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      }
    },

    // ---------------------------------------------------------------- 详情抽屉

    async openDetail(app) {
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
        this.detail.app = data.installed ?? app;
        this.detail.manifest = data.manifest ?? null;
        this.detail.available = data.available ?? [];
      } catch (error) {
        this.detail.error = errorMessage(error);
      } finally {
        this.detail.loading = false;
      }
    },

    closeDetail() {
      if (this.detail.open) this.detail = { ...this.detail, open: false };
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
