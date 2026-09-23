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
 * 把后端可能返回的各种 error 形态统一成 JobError（{ code, message, detail }）。
 *
 * 必须保持对象形态：任务列表每一行用 `job.error.message` 渲染错误文案。
 * 旧实现把它转成了字符串，于是 SSE 的 done 事件一到达，该行的错误提示就再也显示不出来
 * （要等 /jobs 重新拉取才恢复），而详情面板走的是另一条链路，形态不一致。
 */
function toJobError(raw) {
  if (raw == null) return null;
  if (typeof raw === 'string') return { code: 'ERROR', message: raw };
  if (typeof raw === 'object') {
    const message =
      typeof raw.message === 'string' && raw.message.trim()
        ? raw.message
        : (() => { try { return JSON.stringify(raw); } catch { return String(raw); } })();
    return { code: typeof raw.code === 'string' ? raw.code : 'ERROR', message, detail: raw.detail };
  }
  return { code: 'ERROR', message: String(raw) };
}

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
  /** 日志行的稳定 key（用数组下标会让日志超过 600 行后整块 DOM 重建） */
  let logSeq = 0;
  /** 当前这条 SSE 流对应的任务 id —— 事件回调一律以它为准，而不是「当前选中项」 */
  let streamJobId = '';
  /** 已处理过终态的任务 id（防重复收尾，见 handleEvent 里的说明） */
  const finalizedJobs = new Set();
  /** 上限：任务列表本身也有清理，这里跟着封顶，避免长期运行后无限增长 */
  const FINALIZED_LIMIT = 200;

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
    /** 正在重放某个任务的请求：用于禁用重试按钮，避免连点提交重复任务 */
    retrying: false,

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
      const start = Number(job.startedAt);
      if (!Number.isFinite(start)) return '—';
      // 未结束的任务以 shell.now 为参照：它每秒递增，看板上的「耗时」才会跟着走。
      // 已结束的任务走 endedAt 分支、不读 shell.now，因此不会每秒重渲染。
      const end = job.endedAt != null ? Number(job.endedAt) : shell.now || Date.now();
      if (!Number.isFinite(end)) return '—';
      return formatDuration(end - start);
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
      // 事件回调里不要再读 this.activeId：用户切换选中项后，
      // 旧任务的 status/done 事件会把新任务的状态改掉。
      streamJobId = id;
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
      // 以「这条流对应的任务」为准，而不是用户当前选中的任务
      const jobId = streamJobId;

      if (type === 'log' && payload) {
        this.logs.push({
          key: ++logSeq,
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
        this.logs.push({ key: ++logSeq, seq: 0, ts: Date.now(), stream: 'system', text: payload.message ?? '部分日志已丢失。' });
        return;
      }

      if (type === 'status' && payload) {
        this.patchJob(jobId, { status: payload.status });
        return;
      }

      if (type === 'done' && payload) {
        /**
         * 终态事件按定义只该处理一次。
         *
         * 重复处理的后果不只是日志重复：每个重复的 done 都会走一遍
         * `refreshAll({ force: true })`（强制重扫磁盘 + 重建清单索引，约 1 秒），
         * 表现为顶栏「刷新」按钮在可用/禁用之间持续闪烁；同时 shell.running
         * 会被多扣、任务角标失真。
         *
         * 来源可能是桌面端 IPC 垫片重复投递（web 端直连 EventSource 时正常），
         * 也可能是 SSE 断线重放 —— 都在这里挡掉。
         */
        if (finalizedJobs.has(jobId)) {
          console.warn('[jobs] 忽略重复的终态事件', jobId, payload.status);
          return;
        }
        finalizedJobs.add(jobId);
        if (finalizedJobs.size > FINALIZED_LIMIT) {
          const oldest = finalizedJobs.values().next().value;
          if (oldest) finalizedJobs.delete(oldest);
        }

        this.patchJob(jobId, {
          status: payload.status,
          exitCode: payload.exitCode ?? null,
          error: toJobError(payload.error),
          canCancel: false,
        });
        void this.load();
        // 用户可能已经切到别的任务去看日志了，这时不要把详情面板换成旧任务的
        if (this.activeId === jobId) void this.loadDetail(jobId);
        // 提交方（配置开关、Bucket 增删等）可能注册了后置动作，例如重新拉取数据
        shell.notifyJobDone(jobId, payload.status);
        shell.running = Math.max(0, shell.running - 1);
        if (payload.status === 'succeeded') {
          // 变更类任务成功后，缓存与索引都可能已过期；force 让后端重读磁盘，
          // 同时静默同步已安装列表（覆盖在任务页点「重试」成功的场景）。
          void shell.refreshAll({ force: true, silentOnboarding: true });
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

    /**
     * 能否一键重试：任务里带着可重放的原始请求。
     *
     * 由后端在创建任务时决定（只有能重放的任务才会带 request），
     * 前端不再维护一份「哪些 kind 可重试」的白名单 —— 那正是之前参数丢失的根因：
     * 从展示用的 target 反推请求，global / arch / force 全都丢了。
     */
    canRetry(job) {
      return Boolean(job && job.request && typeof job.request.path === 'string');
    },

    /** 原样重放任务的原始请求。 */
    async retry(job) {
      if (this.retrying) return;
      if (!this.canRetry(job)) {
        shell.toast('该任务没有可重放的请求记录，请回到对应页面重新操作。', 'info');
        return;
      }

      const method = String(job.request.method || 'POST').toUpperCase();
      const fullPath = String(job.request.path);
      // jobs.json 是用户可写的文件，重放前再校验一次路径：只允许同源 /api 路径
      if (!fullPath.startsWith('/api/') || fullPath.includes('..')) {
        shell.toast('任务记录里的请求路径不可用，无法重试。', 'warn');
        return;
      }
      // api 客户端会自己补 /api 前缀（含部署前缀），这里去掉
      const path = fullPath.slice('/api'.length);
      const body = job.request.body ?? {};

      this.retrying = true;
      try {
        const data =
          method === 'GET'
            ? await api.get(path)
            : method === 'PUT'
              ? await api.put(path, body)
              : method === 'DELETE'
                ? await api.del(path)
                : await api.post(path, body);

        if (data && data.job) {
          shell.trackJob(data.job, { stay: true });
          shell.toast('已重新提交任务', 'success');
        } else {
          shell.toast('已重新执行该请求。', 'success');
        }
        await this.load();
      } catch (error) {
        shell.toast(errorMessage(error), 'danger');
      } finally {
        this.retrying = false;
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
