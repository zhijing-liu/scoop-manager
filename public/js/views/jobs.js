/**
 * 视图 6：任务与日志。
 *
 * SSE 句柄与轮询定时器刻意放在闭包里，而不是挂在 Alpine 数据树上：
 * 它们不需要（也不应该）被响应式代理包装。
 */

import { api, errorMessage } from '../api.js';
import { openJobStream } from '../sse.js';
import { formatClock, formatDuration, formatTime, jobKindLabel, jobStatusMeta } from '../format.js';

const MAX_LOG_LINES = 4000;

/**
 * 等一次渲染后再执行。
 *
 * 不能用 `this.$nextTick`：Alpine 的 magic（$nextTick / $el / $refs…）只注入在
 * x-data 的根组件上，视图对象（shell.jobs）里拿不到，调用会直接抛
 * 「this.$nextTick is not a function」——该异常此前被 SSE 的事件回调吞掉，
 * 表现为「自动滚动」静默失效。
 * Alpine 的 DOM 更新走微任务，所以宏任务的 setTimeout 一定排在其后。
 */
function afterRender(fn) {
  setTimeout(fn, 0);
}

export function createJobs(shell) {
  let stream = null;
  let listTimer = null;

  function detach() {
    if (stream) {
      stream.close();
      stream = null;
    }
  }

  function startListPolling(vm) {
    if (listTimer) return;
    listTimer = setInterval(() => {
      if (shell.running > 0 || vm.items.some((item) => item.status === 'running' || item.status === 'queued')) {
        void vm.load();
      } else {
        clearInterval(listTimer);
        listTimer = null;
      }
    }, 4000);
  }

  return {
    items: [],
    loading: false,
    error: '',
    filterStatus: '',
    /** 「状态筛选」下拉的选项（自绘下拉） */
    statusOptions: [
      { value: '', label: '全部状态' },
      { value: 'running', label: '执行中' },
      { value: 'queued', label: '排队中' },
      { value: 'succeeded', label: '成功' },
      { value: 'failed', label: '失败' },
      { value: 'canceled', label: '已取消' },
      { value: 'timeout', label: '超时' },
    ],
    activeId: '',
    detail: null,
    logs: [],
    truncated: false,
    autoScroll: true,
    streamState: 'closed',
    cancelling: false,
    clearing: false,

    async load() {
      this.loading = this.items.length === 0;
      this.error = '';
      try {
        const params = new URLSearchParams();
        params.set('limit', '120');
        if (this.filterStatus) params.set('status', this.filterStatus);
        const data = await api.get(`/jobs?${params.toString()}`);
        this.items = data.items ?? [];
        shell.running = data.running ?? 0;
        shell.queued = data.queued ?? 0;
        if (shell.running > 0) startListPolling(this);
      } catch (error) {
        this.error = errorMessage(error);
      } finally {
        this.loading = false;
      }
    },

    get filtered() {
      if (!this.filterStatus) return this.items;
      return this.items.filter((item) => item.status === this.filterStatus);
    },

    get runningCount() {
      return this.items.filter((item) => item.status === 'running' || item.status === 'queued').length;
    },

    get activeJob() {
      return this.items.find((item) => item.id === this.activeId) ?? this.detail ?? null;
    },

    /**
     * 只渲染末尾一段日志。
     * 安装类任务动辄上万行，全量绑定到 DOM 会让页面卡死；缓冲上限仍保留 4000 行，
     * 需要完整内容时用「复制 / 下载」即可。
     */
    get visibleLogs() {
      const limit = 600;
      return this.logs.length > limit ? this.logs.slice(-limit) : this.logs;
    },

    get hiddenLogCount() {
      return Math.max(0, this.logs.length - 600);
    },

    statusMeta(status) {
      return jobStatusMeta(status);
    },

    kindLabel(kind) {
      return jobKindLabel(kind);
    },

    clock(ts) {
      return formatClock(ts);
    },

    time(ts) {
      return formatTime(ts);
    },

    durationOf(job) {
      if (!job?.startedAt) return '—';
      const end = job.endedAt ?? Date.now();
      return formatDuration(end - job.startedAt);
    },

    // ---------------------------------------------------------------- 实时日志

    /**
     * 建立（或重建）到指定任务的实时流。
     * 服务端会先按 seq 重放历史事件，因此刷新页面后依然能看到完整日志。
     */
    watch(id, options = {}) {
      if (!id) return;
      detach();
      this.activeId = id;
      if (!options.keepLogs) {
        this.logs = [];
        this.truncated = false;
      }
      this.streamState = 'connecting';
      shell.jobStreamState = 'connecting';

      stream = openJobStream(id, {
        onEvent: (event) => this.handleEvent(event),
        onState: (state) => {
          this.streamState = state;
          shell.jobStreamState = state;
        },
      });
    },

    async select(id) {
      if (this.activeId === id && stream && !stream.closed) return;
      this.detail = null;
      this.watch(id);
      this.focusLog();
      shell.activeJobId = id;
      await this.loadDetail(id);
    },

    /**
     * 窄屏下把日志面板滚进可视区。
     *
     * 手机上任务列表与日志面板是上下排列（列表在前），切换任务后如果不滚动，
     * 用户看到的仍然是列表，会以为「点了没反应」。
     */
    focusLog() {
      if (typeof window === 'undefined' || window.innerWidth > 768) return;
      afterRender(() => {
        document.querySelector('.panel-log')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    },

    async loadDetail(id) {
      try {
        this.detail = await api.get(`/jobs/${encodeURIComponent(id)}`);
      } catch (error) {
        this.detail = null;
        shell.toast(errorMessage(error), 'danger');
      }
    },

    handleEvent({ type, payload }) {
      if (type === 'log' && payload) {
        this.logs.push({
          seq: payload.seq,
          ts: payload.ts,
          stream: payload.stream ?? 'stdout',
          text: payload.text ?? '',
        });
        if (this.logs.length > MAX_LOG_LINES) {
          this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
          this.truncated = true;
        }
        if (this.autoScroll) afterRender(() => this.scrollToBottom());
        return;
      }

      if (type === 'notice' && payload) {
        this.truncated = true;
        this.logs.push({ seq: 0, ts: Date.now(), stream: 'system', text: payload.message ?? '部分日志已丢失。' });
        return;
      }

      if (type === 'status' && payload) {
        this.patchJob(this.activeId, { status: payload.status });
        return;
      }

      if (type === 'done' && payload) {
        this.patchJob(this.activeId, {
          status: payload.status,
          exitCode: payload.exitCode ?? null,
          error: payload.error ?? null,
          canCancel: false,
        });
        void this.load();
        void this.loadDetail(this.activeId);
        // 提交方（配置开关、Bucket 增删等）可能注册了后置动作，例如重新拉取数据
        shell.notifyJobDone(this.activeId, payload.status);
        shell.running = Math.max(0, shell.running - 1);
        if (payload.status === 'succeeded') {
          // 变更类任务成功后，缓存与索引都可能已过期
          void shell.refreshAll({ silentOnboarding: true });
        }
      }
    },

    patchJob(id, patch) {
      const index = this.items.findIndex((item) => item.id === id);
      if (index >= 0) this.items[index] = { ...this.items[index], ...patch };
      if (this.detail?.id === id) this.detail = { ...this.detail, ...patch };
    },

    scrollToBottom() {
      const element = document.getElementById('job-log-viewport');
      if (element) element.scrollTop = element.scrollHeight;
    },

    toggleAutoScroll() {
      this.autoScroll = !this.autoScroll;
      if (this.autoScroll) afterRender(() => this.scrollToBottom());
    },

    clearLogView() {
      this.logs = [];
      this.truncated = false;
    },

    // ---------------------------------------------------------------- 操作

    async cancel(id) {
      this.cancelling = true;
      try {
        const data = await api.post(`/jobs/${encodeURIComponent(id)}/cancel`);
        shell.toast(data.state === 'canceled' ? '任务已取消。' : '已发送取消请求，正在终止进程…', 'info');
        await this.load();
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.cancelling = false;
      }
    },

    async removeOne(id) {
      try {
        await api.del(`/jobs/${encodeURIComponent(id)}`);
        if (this.activeId === id) {
          detach();
          this.activeId = '';
          this.detail = null;
          this.logs = [];
        }
        await this.load();
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      }
    },

    async clearFinished() {
      this.clearing = true;
      try {
        const data = await api.post('/jobs/clear');
        shell.toast(`已清理 ${data.removed} 条历史任务`, 'success');
        detach();
        this.activeId = '';
        this.detail = null;
        this.logs = [];
        await this.load();
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.clearing = false;
      }
    },

    /** 只有能从任务元信息还原出原始请求的类型，才允许一键重试 */
    canRetry(job) {
      return [
        'app.install',
        'app.uninstall',
        'app.update',
        'app.cleanup',
        'app.reset',
        'bucket.update',
        'scoop.checkup',
        'scoop.update',
        'cache.remove',
      ].includes(job.kind);
    },

    async retry(job) {
      const targets = (job.target ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);

      try {
        switch (job.kind) {
          case 'app.install': {
            const data = await api.post('/apps/install', { apps: targets });
            shell.trackJob(data.job, { stay: true });
            break;
          }
          case 'app.uninstall': {
            const data = await api.post('/apps/uninstall', { apps: targets, purge: true });
            shell.trackJob(data.job, { stay: true });
            break;
          }
          case 'app.update': {
            const payload = targets.includes('*') || targets.length === 0 ? { all: true } : { apps: targets };
            const data = await api.post('/apps/update', payload);
            shell.trackJob(data.job, { stay: true });
            break;
          }
          case 'app.cleanup': {
            const data = await api.post('/cache/cleanup', { apps: targets });
            shell.trackJob(data.job, { stay: true });
            break;
          }
          case 'app.reset': {
            const data = await api.post('/apps/reset', { apps: targets });
            shell.trackJob(data.job, { stay: true });
            break;
          }
          case 'bucket.update': {
            const data = await api.post('/buckets/update', { name: targets[0] ?? null });
            shell.trackJob(data.job, { stay: true });
            break;
          }
          case 'scoop.checkup': {
            const data = await api.post('/scoop/checkup');
            shell.trackJob(data.job, { stay: true });
            break;
          }
          case 'scoop.update': {
            const data = await api.post('/scoop/self-update');
            shell.trackJob(data.job, { stay: true });
            break;
          }
          case 'cache.remove': {
            const data = await api.post('/cache/remove', { target: targets[0] ?? null });
            shell.trackJob(data.job, { stay: true });
            break;
          }
          default:
            shell.toast('该任务类型暂不支持一键重试，请回到对应页面重新操作。', 'info');
            return;
        }
        shell.toast('已重新提交任务', 'success');
        await this.load();
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      }
    },

    // ---------------------------------------------------------------- 导出

    logsAsText() {
      return this.logs.map((line) => `[${formatClock(line.ts)}] [${line.stream}] ${line.text}`).join('\n');
    },

    async copyLogs() {
      await shell.copyText(this.logsAsText());
    },

    downloadLogs() {
      const job = this.activeJob;
      const name = job ? `job-${job.kind}-${job.id.slice(0, 8)}.log` : 'job.log';
      const header = job
        ? `# ${job.title}\n# 状态: ${job.status}  退出码: ${job.exitCode ?? '-'}\n# 开始: ${formatTime(job.startedAt)}\n\n`
        : '';
      try {
        const blob = new Blob([header + this.logsAsText()], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      } catch {
        shell.toast('下载日志失败。', 'warn');
      }
    },
  };
}
