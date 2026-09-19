/**
 * 视图 4：Bucket 管理。
 */

import { api, errorMessage } from '../api.js';
import { formatNumber, fromNow } from '../format.js';

export function createBuckets(shell) {
  return {
    items: [],
    known: [],
    knownSource: '',
    indexStats: null,
    loading: false,
    error: '',
    busy: '',
    form: { open: false, name: '', repoUrl: '', error: '', submitting: false },

    async load() {
      this.loading = true;
      this.error = '';
      try {
        const data = await api.get('/buckets');
        this.items = data.items ?? [];
        this.indexStats = data.index ?? null;
        void this.loadKnown();
      } catch (error) {
        this.error = errorMessage(error);
      } finally {
        this.loading = false;
      }
    },

    async loadKnown() {
      try {
        const data = await api.get('/buckets/known');
        this.known = data.items ?? [];
        this.knownSource = data.source ?? '';
      } catch {
        // 忽略：known 列表只是推荐项
      }
    },

    get totalManifests() {
      return this.items.reduce((sum, item) => sum + (item.manifestCount ?? 0), 0);
    },

    get notAdded() {
      return this.known.filter((item) => !item.added);
    },

    openForm() {
      this.form = { open: true, name: '', repoUrl: '', error: '', submitting: false };
    },

    closeForm() {
      this.form = { ...this.form, open: false };
    },

    validateForm() {
      const name = this.form.name.trim();
      if (!name) return this.syncFormError('请填写 Bucket 名称。');
      if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(name)) {
        return this.syncFormError('名称只允许字母、数字与 . _ + -，且必须以字母或数字开头。');
      }
      if (this.items.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
        return this.syncFormError(`Bucket「${name}」已经存在。`);
      }
      const repo = this.form.repoUrl.trim();
      if (repo && !/^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/i.test(repo)) {
        return this.syncFormError('仓库地址应以 https:// 、git@ 或 ssh:// 开头；留空则使用 Scoop 内置的已知仓库。');
      }
      this.form.error = '';
      return true;
    },

    syncFormError(message) {
      this.form.error = message;
      return false;
    },

    async submitAdd() {
      if (!this.validateForm()) return;
      this.form.submitting = true;
      try {
        const data = await api.post('/buckets', {
          name: this.form.name.trim(),
          repoUrl: this.form.repoUrl.trim() || null,
        });
        this.closeForm();
        shell.trackJob(data.job);
      } catch (error) {
        this.form.error = errorMessage(error);
      } finally {
        this.form.submitting = false;
      }
    },

    async quickAdd(item) {
      if (item.added) return;
      this.busy = item.name;
      try {
        const data = await api.post('/buckets', { name: item.name });
        shell.trackJob(data.job);
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.busy = '';
      }
    },

    async remove(item) {
      const confirmed = await shell.askConfirm({
        title: `删除 Bucket：${item.name}`,
        message: `将移除「${item.name}」及其 ${formatNumber(item.manifestCount)} 个应用清单。`,
        detail: '已安装的应用不会被卸载，但之后将无法从该 Bucket 更新。',
        confirmText: '删除',
        danger: true,
      });
      if (!confirmed) return;
      this.busy = item.name;
      try {
        const data = await api.del(`/buckets/${encodeURIComponent(item.name)}`);
        shell.trackJob(data.job);
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.busy = '';
      }
    },

    async update(item) {
      this.busy = item.name;
      try {
        const data = await api.post('/buckets/update', { name: item.name });
        shell.trackJob(data.job);
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.busy = '';
      }
    },

    async updateAll() {
      const data = await shell.runAction(() => api.post('/buckets/update', {}));
      if (data) shell.trackJob(data.job);
    },

    searchInBucket(name) {
      shell.setView('discover');
      shell.discover.bucket = name;
      shell.discover.query = '';
      shell.discover.searched = true;
      void shell.discover.search();
    },

    relative(ts) {
      return fromNow(ts);
    },
  };
}
