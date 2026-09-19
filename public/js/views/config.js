/**
 * 视图 5：配置与代理。
 *
 * 配置读取直接解析 config.json；写入一律走 `scoop config`，让 Scoop 自己
 * 做校验与落盘，避免我们写出它不认识的格式。
 */

import { api, errorMessage } from '../api.js';

export function createConfigView(shell) {
  return {
    snapshot: null,
    keys: [],
    loading: false,
    error: '',
    busy: '',
    reveal: {},
    proxyInput: '',
    proxyEditing: false,
    proxyTest: { running: false, done: false, ok: false, ms: 0, error: '', hint: '', target: null },
    edit: { open: false, key: '', value: '', error: '', submitting: false },
    add: { open: false, key: '', value: '', error: '', submitting: false },

    async load() {
      this.loading = true;
      this.error = '';
      try {
        const [snapshot] = await Promise.all([api.get('/config'), this.loadKeys()]);
        this.snapshot = snapshot;
        this.proxyInput = snapshot.proxy?.value ?? '';
        this.proxyEditing = false;
      } catch (error) {
        this.error = errorMessage(error);
      } finally {
        this.loading = false;
      }
    },

    async loadKeys() {
      try {
        const data = await api.get('/config/keys');
        this.keys = data.items ?? [];
      } catch {
        this.keys = [];
      }
    },

    get entries() {
      return this.snapshot?.entries ?? [];
    },

    get proxyMode() {
      return this.snapshot?.proxy?.mode ?? 'none';
    },

    /** 代理来自 scoop config 还是本程序自身配置（Scoop 未安装时只能是后者）。 */
    get proxySource() {
      return this.snapshot?.proxy?.source ?? 'none';
    },

    /** Scoop 是否已安装：决定代理写往哪里、以及提示文案。 */
    get scoopInstalled() {
      return Boolean(shell.env?.installed);
    },

    get proxyDisplay() {
      return this.snapshot?.proxy?.display ?? null;
    },

    get proxyValid() {
      const value = this.proxyInput.trim();
      if (!value) return true;
      if (value === 'current' || value === 'none') return true;
      return /^(https?:\/\/)?([^\s@/]+(:[^\s@/]*)?@)?[A-Za-z0-9.\-_]+(:\d{1,5})?$/.test(value);
    },

    get keysNotSet() {
      const existing = new Set(this.entries.map((entry) => entry.key.toLowerCase()));
      return this.keys.filter((meta) => !existing.has(meta.key.toLowerCase()));
    },

    valueOf(key) {
      const found = this.entries.find((entry) => entry.key === key);
      return found ? found.value : undefined;
    },

    entryOf(key) {
      return this.entries.find((entry) => entry.key === key) ?? null;
    },

    displayValue(entry) {
      if (entry.sensitive && !this.reveal[entry.key]) {
        const text = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value);
        return text ? text.replace(/(:)[^:@/]+(@)/, '$1***$2') : '••••••';
      }
      if (typeof entry.value === 'string') return entry.value;
      if (entry.value === null || entry.value === undefined) return '—';
      return JSON.stringify(entry.value);
    },

    toggleReveal(key) {
      this.reveal = { ...this.reveal, [key]: !this.reveal[key] };
    },

    // ---------------------------------------------------------------- 代理

    async applyProxy() {
      const value = this.proxyInput.trim();
      if (!this.proxyValid) {
        shell.toast('代理地址格式不合法，请检查后重试。', 'danger');
        return;
      }
      if (!value) {
        await this.clearProxy();
        return;
      }
      this.busy = 'proxy';
      try {
        const data = await api.put('/config/proxy', { value });
        this.proxyEditing = false;
        // Scoop 未安装时没有 scoop 命令可跑，接口直接落库并返回 job: null
        if (data.job) {
          // 配置写入是异步任务：结束后重新拉取，界面上才是配置文件里的真实值
          shell.trackJob(data.job, { stay: true, onDone: () => void this.load() });
        } else {
          shell.toast('代理已保存到本程序，将在安装 Scoop 时自动使用。', 'success');
          await this.load();
        }
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.busy = '';
      }
    },

    async clearProxy() {
      const confirmed = await shell.askConfirm({
        title: '清除代理配置',
        message: this.scoopInstalled
          ? '将执行 scoop config rm proxy，之后下载将不再使用代理。'
          : '将清除本程序保存的代理，之后安装 Scoop 时不再使用该代理。',
        confirmText: '清除',
        danger: true,
      });
      if (!confirmed) return;
      this.busy = 'proxy';
      try {
        const data = await api.del('/config/proxy');
        this.proxyInput = '';
        this.proxyEditing = false;
        if (data.job) {
          // 配置写入是异步任务：结束后重新拉取，界面上才是配置文件里的真实值
          shell.trackJob(data.job, { stay: true, onDone: () => void this.load() });
        } else {
          shell.toast('已清除本程序保存的代理。', 'success');
          await this.load();
        }
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.busy = '';
      }
    },

    async useSystemProxy() {
      this.proxyInput = 'current';
      await this.applyProxy();
    },

    async testProxy() {
      this.proxyTest = { running: true, done: false, ok: false, ms: 0, error: '', hint: '', target: null };
      try {
        const value = this.proxyInput.trim();
        const data = await api.post('/config/proxy/test', value ? { value } : {});
        this.proxyTest = {
          running: false,
          done: true,
          ok: Boolean(data.ok),
          ms: data.ms ?? 0,
          error: data.error ?? '',
          hint: data.hint ?? '',
          target: data.target ?? null,
        };
      } catch (error) {
        this.proxyTest = { running: false, done: true, ok: false, ms: 0, error: errorMessage(error), hint: '', target: null };
      }
    },

    // ---------------------------------------------------------------- 增删改

    openEdit(entry) {
      const raw = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value ?? '');
      this.edit = { open: true, key: entry.key, value: raw, error: '', submitting: false };
    },

    closeEdit() {
      this.edit = { ...this.edit, open: false };
    },

    async submitEdit() {
      const key = this.edit.key;
      const value = this.edit.value;
      this.edit.submitting = true;
      try {
        const data = await api.put('/config', { key, value: this.coerce(key, value) });
        this.closeEdit();
        // 配置写入是异步任务：结束后重新拉取，界面上才是配置文件里的真实值
        shell.trackJob(data.job, { stay: true, onDone: () => void this.load() });
        shell.toast(`已提交修改：${key}`, 'info');
      } catch (error) {
        this.edit.error = errorMessage(error);
      } finally {
        this.edit.submitting = false;
      }
    },

    openAdd() {
      this.add = { open: true, key: '', value: '', error: '', submitting: false };
    },

    closeAdd() {
      this.add = { ...this.add, open: false };
    },

    quickFill(meta) {
      this.add = { open: true, key: meta.key, value: meta.suggestion ?? '', error: '', submitting: false };
    },

    async submitAdd() {
      const key = this.add.key.trim();
      if (!/^[A-Za-z][A-Za-z0-9._-]*$/.test(key)) {
        this.add.error = '键名只允许字母、数字与 . _ -，且必须以字母开头。';
        return;
      }
      if (this.entries.some((entry) => entry.key.toLowerCase() === key.toLowerCase())) {
        this.add.error = `配置项「${key}」已存在，请直接编辑。`;
        return;
      }
      this.add.submitting = true;
      try {
        const data = await api.put('/config', { key, value: this.coerce(key, this.add.value) });
        this.closeAdd();
        // 配置写入是异步任务：结束后重新拉取，界面上才是配置文件里的真实值
        shell.trackJob(data.job, { stay: true, onDone: () => void this.load() });
      } catch (error) {
        this.add.error = errorMessage(error);
      } finally {
        this.add.submitting = false;
      }
    },

    async removeKey(key) {
      const confirmed = await shell.askConfirm({
        title: `删除配置：${key}`,
        message: '将执行 scoop config rm，删除后该项恢复默认行为。',
        confirmText: '删除',
        danger: true,
      });
      if (!confirmed) return;
      this.busy = key;
      try {
        const data = await api.del(`/config/${encodeURIComponent(key)}`);
        // 配置写入是异步任务：结束后重新拉取，界面上才是配置文件里的真实值
        shell.trackJob(data.job, { stay: true, onDone: () => void this.load() });
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.busy = '';
      }
    },

    /**
     * 常用键快捷开关：布尔型直接取反。
     *
     * 这里必须做两件事，否则开关会"点了没反应"：
     *   1. 乐观更新本地快照 —— scoop config 是异步任务，不能等到任务结束才翻开关
     *   2. 任务结束后重新 load() —— 以配置文件里的真实值为准；
     *      任务失败时开关会自己回到原来的状态
     */
    async toggleMeta(meta) {
      const entry = this.entryOf(meta.key);
      const current = entry ? entry.value : undefined;
      const next = !(current === true || current === 'true');
      const previous = this.snapshot;
      this.patchEntry(meta.key, next);
      try {
        const data = await api.put('/config', { key: meta.key, value: next });
        shell.trackJob(data.job, { stay: true, onDone: () => void this.load() });
        shell.toast(`${meta.label}：${next ? '已开启' : '已关闭'}`, 'success');
      } catch (error) {
        this.snapshot = previous;
        shell.toast(errorMessage(error), 'danger');
      }
    },

    /** 本地插入/更新一条配置（乐观 UI 用；最终值仍以 load() 拉取的结果为准） */
    patchEntry(key, value) {
      if (!this.snapshot) return;
      const entries = [...(this.snapshot.entries ?? [])];
      const index = entries.findIndex((entry) => entry.key === key);
      if (index >= 0) {
        entries[index] = { ...entries[index], value };
      } else {
        entries.push({ key, value, sensitive: false });
      }
      this.snapshot = { ...this.snapshot, entries };
    },

    isTruthy(meta) {
      const entry = this.entryOf(meta.key);
      if (!entry) return false;
      return entry.value === true || entry.value === 'true' || entry.value === 1 || entry.value === '1';
    },

    /** 表单里输入的字符串按 scoop 的约定做轻量类型推断 */
    coerce(key, value) {
      const text = String(value ?? '').trim();
      if (text === 'true') return true;
      if (text === 'false') return false;
      if (text !== '' && /^-?\d+$/.test(text) && key !== 'proxy') return Number.parseInt(text, 10);
      return text;
    },

    refresh() {
      void this.load();
    },
  };
}
