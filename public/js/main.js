/**
 * 应用装配层。
 *
 * 这里只负责三件事：
 *   1. 组装全局 shell（导航、Toast、确认弹层、环境刷新、任务跟踪）
 *   2. 把 6 个视图模块的局部状态挂到同一棵 Alpine 数据树上
 *   3. 在 Alpine 就绪后注册组件并显式启动
 *
 * 之所以用「单一 Alpine.data('app')」，是因为各视图之间需要大量交叉跳转
 * （例如概览页点「更新」要跳到任务页、Bucket 页点「搜索」要跳到搜索页），
 * 拆分多个 x-data 反而会把状态同步搞复杂。
 */

import { api, errorMessage, errorDetail } from './api.js';
import { externalUrl } from './format.js';
import { createDashboard } from './views/dashboard.js';
import { createInstalled } from './views/installed.js';
import { createDiscover } from './views/discover.js';
import { createBuckets } from './views/buckets.js';
import { createConfigView } from './views/config.js';
import { createJobs } from './views/jobs.js';

export const NAV_ITEMS = [
  { id: 'dashboard', label: '环境概览', icon: 'grid', hint: '检测与快捷操作' },
  { id: 'installed', label: '已安装应用', icon: 'box', hint: '更新 / 卸载 / 锁定' },
  { id: 'discover', label: '搜索与安装', icon: 'search', hint: '本地 bucket 即时搜索' },
  { id: 'buckets', label: 'Bucket 管理', icon: 'layers', hint: '仓库添加与更新' },
  { id: 'config', label: '配置与代理', icon: 'sliders', hint: 'scoop config' },
  { id: 'jobs', label: '任务与日志', icon: 'terminal', hint: '实时输出与取消' },
];

const VIEW_STORAGE_KEY = 'scoop-manager.view';
const NAV_COLLAPSE_KEY = 'scoop-manager.nav-collapsed';

/**
 * 桌面模式探测：IPC 垫片里已经用同样的判断式，保持一致。
 * 浏览器访问时这个值就是 false，标题栏三按钮 + 拖拽区域都由 x-show 挡掉，
 * 让 web 端和桌面端共用同一套 DOM。
 */
const TAURI = window.__TAURI__;
const IS_DESKTOP = Boolean(TAURI && TAURI.window && typeof TAURI.window.getCurrentWindow === 'function');

/** 桌面端窗口句柄（懒获取，首次使用前才触发）。 */
let win = null;
function getWin() {
  if (!IS_DESKTOP) return null;
  if (!win) win = TAURI.window.getCurrentWindow();
  return win;
}

/** 抽屉形态的临界宽度，与 style.css 的 max-width:768px 媒体查询保持一致。 */
const NAV_DRAWER_MAX_WIDTH = 768;

/** 是否处于「侧栏变抽屉」的窄屏形态（与 style.css 的 max-width:768px 一致）。 */
function isDrawerLayout() {
  return typeof window !== 'undefined' && window.innerWidth <= NAV_DRAWER_MAX_WIDTH;
}

/** 从地址栏 hash 解析视图 id，格式为 `#buckets`；历史链接 `#/buckets` 同样兼容。 */
function viewFromHash() {
  try {
    const raw = decodeURIComponent(window.location.hash || '').replace(/^#\/?/, '').trim();
    return NAV_ITEMS.some((item) => item.id === raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 把当前视图写回地址栏。
 *
 * @param replace true 时用 replaceState，只改地址不新增历史记录（用于首次同步）；
 *                平时走 location.hash，于是浏览器前进/后退可以在视图之间跳转。
 */
function writeHash(id, replace = false) {
  try {
    const next = `#${id}`;
    if (window.location.hash === next) return;
    if (replace && window.history && typeof window.history.replaceState === 'function') {
      window.history.replaceState(null, '', next);
    } else {
      window.location.hash = next;
    }
  } catch {
    // 某些嵌入/受限环境不允许改地址栏，忽略即可（localStorage 仍是兜底）
  }
}

function createShell() {
  // 「任务完成后要做的事」登记表：key 是任务 id。
  // 刻意放在闭包里而不是 shell 响应式对象上，避免被 Alpine 的代理包一层。
  const jobDoneHandlers = new Map();
  // 进行中的全局刷新：所有重入调用复用同一个 Promise，
  // 避免并发刷新被静默丢弃（旧实现遇到 refreshing=true 直接 return）。
  let refreshInFlight = null;
  // 正在跑的这轮刷新是否带了 force（强制重读磁盘）
  let inFlightForce = false;
  // 是否已排队「等当前刷新结束后补做一轮强制刷新」
  let forceQueued = false;

  const shell = {
    // ------------------------------------------------------------ 导航与布局
    navItems: NAV_ITEMS,
    view: 'dashboard',
    // 抽屉形态（窄屏）下控制侧栏滑入滑出
    sidebarOpen: false,
    // 常驻形态（宽屏）下控制侧栏收起为「只留图标」；窄屏默认收起
    sidebarCollapsed: (() => {
      try {
        const saved = localStorage.getItem(NAV_COLLAPSE_KEY);
        if (saved !== null) return saved === 'true';
      } catch {
        // localStorage 不可用时忽略
      }
      return typeof window !== 'undefined' ? window.innerWidth <= 1024 : false;
    })(),
    booting: true,
    fatal: '',

    // ------------------------------------------------------------ 桌面模式
    /** true = Tauri 外壳（无边框窗口 + 自绘标题栏）；false = 浏览器 / 服务模式 */
    isDesktop: IS_DESKTOP,
    /** 桌面窗口是否处于最大化，用于切换按钮图标（最大化 / 还原） */
    isMaximized: false,

    // ------------------------------------------------------------ 全局数据
    health: null,
    env: null,
    counts: null,
    updates: [],
    updatesNote: '',
    /**
     * 可更新列表的来源：
     *   'status'   → scoop status 的联网权威结果
     *   'manifest' → 本地 bucket 索引比对（bucket 未更新时会滞后）
     */
    updatesSource: 'manifest',
    updatesCachedAt: null,
    proxy: null,
    configFile: null,
    refreshing: false,
    /** 「重新同步」进行中（清缓存 + 重读磁盘 + 等联网复核） */
    resyncing: false,
    lastRefreshAt: null,
    running: 0,
    queued: 0,
    jobStreamState: 'closed',
    now: Date.now(),

    // ------------------------------------------------------------ 反馈组件
    toasts: [],
    toastSeq: 0,
    confirm: { open: false, title: '', message: '', detail: '', confirmText: '确认', danger: true, resolve: null },

    // ------------------------------------------------------------ 首次引导
    onboarding: {
      open: false,
      tab: 'install',
      installDir: '',
      runAsAdmin: false,
      attachDir: '',
      // 安装过程用的代理：Scoop 还没装时 scoop config 不存在，
      // 只能由这里传给安装任务，注入到子进程环境里
      proxy: '',
      proxyTest: { running: false, done: false, ok: false, ms: 0, error: '', hint: '', target: null },
      busy: false,
      error: '',
      dismissed: false,
    },

    /**
     * 首次数据是否就绪。
     *
     * 视图内容一律以此为闸门：接口还没返回时，界面里那些「默认按钮 / 功能区」
     * （一键安装、批量更新、快捷操作等）都不该被渲染出来——它们看着可用，
     * 点下去只会报错，也会让人误以为已经读到了真实状态。
     * 首次请求就失败时同样不放行，此时只需要展示错误提示与重试。
     */
    get ready() {
      return !this.booting && !this.fatal;
    },

    /** 汉堡按钮的提示文案：窄屏抽屉 / 宽屏收起，语义不同 */
    get navToggleTitle() {
      if (isDrawerLayout()) return this.sidebarOpen ? '收起导航' : '展开导航';
      return this.sidebarCollapsed ? '展开侧栏' : '收起侧栏（只留图标）';
    },

    /**
     * 当前视图的加载错误。
     *
     * 各视图的 load() 失败时只会把错误写进自己的 error 字段，而模板里从来没有渲染过它，
     * 于是「请求失败」和「确实没有数据」在界面上长得一模一样（都是空列表 / 骨架屏）。
     * 这里统一聚合，模板只渲染一处即可。
     */
    get activeError() {
      const modules = {
        dashboard: this.dashboard,
        installed: this.installed,
        discover: this.discover,
        buckets: this.buckets,
        config: this.config,
        jobs: this.jobs,
      };
      return modules[this.view]?.error || '';
    },

    /** 错误提示里的「重试」：重新加载当前视图的数据。 */
    reloadView() {
      this.loadView(this.view);
    },

    // ------------------------------------------------------------ 生命周期
    async boot() {
      // 视图恢复的优先级：地址栏 hash > 上次记忆（localStorage）> 默认概览。
      // hash 优先，这样刷新、分享链接、前进/后退都落在同一个视图上。
      const fromHash = viewFromHash();
      let initial = fromHash;
      if (!initial) {
        try {
          const saved = localStorage.getItem(VIEW_STORAGE_KEY);
          if (saved && NAV_ITEMS.some((item) => item.id === saved)) initial = saved;
        } catch {
          // localStorage 不可用时忽略
        }
      }
      if (initial) this.view = initial;
      // 首次同步用 replace：地址栏补上 #/xxx，但不额外压一条历史记录
      writeHash(this.view, true);

      // 用户手动改地址栏 / 前进后退时跟着切换视图
      this._hashHandler = () => {
        const id = viewFromHash();
        if (id) this.applyView(id);
      };
      window.addEventListener('hashchange', this._hashHandler);

      this._tick = setInterval(() => {
        this.now = Date.now();
      }, 1000);
      this._keyHandler = (event) => this.handleKeydown(event);
      window.addEventListener('keydown', this._keyHandler);

      await this.refreshAll();
      this.booting = false;

      // 桌面模式：初始化最大化状态并订阅变化（自绘标题栏需要这个状态切换图标）
      if (IS_DESKTOP) {
        const handle = getWin();
        try {
          this.isMaximized = Boolean(await handle.isMaximized());
          // onResized 在窗口尺寸变化时都会触发，覆盖最大化 / 还原 / 手动 resize 三种路径。
          // 返回的 unlisten 函数在应用 teardown 时调用，避免监听器泄漏。
          this._winResizedUnlisten = await handle.onResized(() => {
            void handle.isMaximized().then((v) => (this.isMaximized = Boolean(v))).catch(() => {});
          });
        } catch {
          // 权限未放行或窗口已销毁：忽略，保持 false
        }
      }

      // 轻量轮询：只同步任务计数与连接状态，不重扫磁盘
      this._poll = setInterval(() => this.refreshRuntime(), 5000);

      // 按需加载当前视图
      this.loadView(this.view);
    },

    /**
     * 顶栏汉堡按钮：两种形态共用同一个按钮，语义不同。
     *
     *   - 宽屏（>768px）：侧栏常驻，点击 = 收起为只留图标 / 再点展开，偏好写入 localStorage
     *   - 窄屏（≤768px）：侧栏是抽屉，点击 = 滑出 / 滑回（完全隐藏，让出全部宽度）
     */
    toggleNav() {
      if (isDrawerLayout()) {
        this.sidebarOpen = !this.sidebarOpen;
        return;
      }
      this.sidebarCollapsed = !this.sidebarCollapsed;
      try {
        localStorage.setItem(NAV_COLLAPSE_KEY, String(this.sidebarCollapsed));
      } catch {
        // 隐私模式等写不进去，不影响本次会话
      }
    },

    handleKeydown(event) {
      if (event.key === 'Escape') {
        // 逐层收起：确认弹层 -> 配置/Bucket 弹层 -> 抽屉 -> 引导 -> 侧栏。
        // 旧实现只处理确认框、侧栏与两个抽屉，配置与 Bucket 的弹层按 Esc 毫无反应。
        if (this.confirm.open) {
          this.settleConfirm(false);
          return;
        }
        if (this.config.edit.open) {
          this.config.closeEdit();
          return;
        }
        if (this.config.add.open) {
          this.config.closeAdd();
          return;
        }
        if (this.buckets.form.open) {
          this.buckets.closeForm();
          return;
        }
        if (this.installed.detail.open) {
          this.installed.closeDetail();
          return;
        }
        if (this.discover.panel.open) {
          this.discover.closeInstallPanel();
          return;
        }
        if (this.onboarding.open) {
          this.dismissOnboarding();
          return;
        }
        this.sidebarOpen = false;
        return;
      }

      // 有弹层 / 抽屉打开时不再响应全局快捷键，
      // 否则 Ctrl+K 与 / 会在弹层背后把视图切走。
      if (
        this.confirm.open ||
        this.config.edit.open ||
        this.config.add.open ||
        this.buckets.form.open ||
        this.discover.panel.open ||
        this.onboarding.open
      ) {
        return;
      }

      const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName ?? '');
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        this.setView('discover');
        setTimeout(() => document.getElementById('discover-input')?.focus(), 60);
        return;
      }
      if (isTyping) return;
      if (event.key === '/') {
        event.preventDefault();
        this.setView('discover');
        setTimeout(() => document.getElementById('discover-input')?.focus(), 60);
      }
    },

    // ------------------------------------------------------------ 视图切换
    setView(id) {
      if (!NAV_ITEMS.some((item) => item.id === id)) return;
      // 先写 hash（会触发 hashchange），再切视图；hashchange 里发现 view 已经一致就不会重复加载
      writeHash(id);
      this.applyView(id);
    },

    /** 真正执行切换：只改状态与加载数据，不碰地址栏（避免与 hashchange 互相触发）。 */
    applyView(id) {
      if (!NAV_ITEMS.some((item) => item.id === id)) return;
      if (id === this.view) return;
      this.view = id;
      this.sidebarOpen = false;
      try {
        localStorage.setItem(VIEW_STORAGE_KEY, id);
      } catch {
        // ignore
      }
      this.loadView(id);
    },

    loadView(id) {
      const loaders = {
        dashboard: () => this.dashboard.load(),
        installed: () => this.installed.load(),
        discover: () => this.discover.load(),
        buckets: () => this.buckets.load(),
        config: () => this.config.load(),
        jobs: () => this.jobs.load(),
      };
      loaders[id]?.();
    },

    // ------------------------------------------------------------ 全局刷新
    /**
     * 拉取全局概览数据（健康状态 / 环境 / 计数 / 可更新列表）。
     *
     * @param {object} options
     * @param {boolean} options.force           强制后端重读磁盘并重建索引
     * @param {boolean} options.silentOnboarding 不弹首次引导
     *
     * 重入策略：刷新进行中时复用同一个 Promise，而不是直接 return 丢弃调用。
     * 任务连续结束、多个入口同时触发刷新时，每个调用方都能等到本轮刷新完成。
     */
    refreshAll(options = {}) {
      const force = options.force === true;

      if (refreshInFlight) {
        // 已有一轮刷新在跑。若本轮要求强制重读磁盘、而正在跑的这轮不是，
        // 就等它结束后补做一次强制刷新，而不是把 force 静默吞掉
        //（否则「任务完成后重读磁盘」会被恰好并行的一轮普通刷新降级成读缓存）。
        if (force && !inFlightForce && !forceQueued) {
          forceQueued = true;
          const pending = refreshInFlight;
          return pending.then(() => {
            forceQueued = false;
            return this.refreshAll(options);
          });
        }
        return refreshInFlight;
      }

      inFlightForce = force;

      const run = (async () => {
        this.refreshing = true;
        this.fatal = '';
        try {
          const overviewPath = options.force ? '/overview?force=1' : '/overview';
          const [health, overview] = await Promise.all([api.get('/health'), api.get(overviewPath)]);
          this.health = health;
          this.applyOverview(overview);

          if (!this.env.installed && !this.onboarding.dismissed && !options.silentOnboarding) {
            this.openOnboarding();
          }
          if (this.env.installed) {
            this.onboarding.open = false;
          }

          // 概览页的「下载缓存」不在 overview 里，是单独一次磁盘扫描。
          // 仅在需要时补一次（点「刷新」、清空缓存 / 清理旧版本之后），
          // 避免每一轮后台刷新都去遍历缓存目录。
          if (options.refreshCache && this.dashboard && this.dashboard.cache) {
            void this.dashboard.load({ silent: true });
          }

          // 已安装页若已加载过，后台静默强制重扫一次。
          // 这是「任务页重试成功后列表不更新」的关键补齐：任务完成只走到这里，
          // 用户不必离开任务页，列表数据就已与磁盘同步；命令行外部变更同理。
          if (this.installed && this.installed.items.length > 0) {
            void this.installed.load(options.force === true, true).catch(() => {});
          }
          // 搜索结果里的「已安装」标记也要跟着磁盘走：否则刚装完/刚卸载的应用
          // 在搜索页仍显示旧状态。这个请求命中同一份已安装快照，代价很低。
          if (this.discover && this.discover.installedNames.length > 0) {
            void this.discover.loadInstalledNames();
          }
        } catch (error) {
          this.fatal = errorMessage(error);
          this.toast(errorMessage(error), 'danger', 8000);
        } finally {
          this.refreshing = false;
        }
      })();

      refreshInFlight = run.finally(() => {
        refreshInFlight = null;
        inFlightForce = false;
      });
      return refreshInFlight;
    },

    /** 把 /overview 的返回值落到全局状态（refreshAll 与轮询共用同一份映射）。 */
    applyOverview(overview) {
      this.env = overview.scoop ?? { installed: false };
      this.counts = overview.counts ?? { installed: 0, global: 0, held: 0, buckets: 0, updatable: 0, cacheBytes: 0, indexEntries: 0 };
      this.updates = overview.updates ?? [];
      this.updatesNote = overview.updatesNote ?? '';
      this.updatesSource = overview.updatesSource ?? 'manifest';
      this.updatesCachedAt = overview.updatesCachedAt ?? null;
      this.proxy = overview.proxy ?? null;
      this.configFile = overview.configFile ?? null;
      this.running = overview.jobs?.running ?? 0;
      this.lastRefreshAt = Date.now();
    },

    /**
     * 只重新拉一次 overview，不做整轮磁盘重扫。
     * 用于等待后台 `scoop status` 回填时的轮询（每次 5 秒、最多 6 次）。
     */
    async refreshOverview() {
      try {
        this.applyOverview(await api.get('/overview'));
      } catch {
        // 轮询失败静默：可能是后台正忙，等下一轮
      }
    },

    /**
     * 一键重新同步 —— 专治「在终端里直接操作过 Scoop，界面数据与磁盘不一致」。
     *
     * 做三件事：
     *   1. 作废后端所有进程内缓存（含 scoop hold 这类目录快照捕捉不到的改动、5 分钟 TTL 的 scoop status）；
     *   2. 重新读磁盘刷新全局数据与当前视图；
     *   3. 有限轮询等待后台 scoop status 回填联网权威的可更新列表。
     *
     * 不做无限等待：串行队列里可能有长任务，超时就交给用户手动「检查更新状态」。
     * 本机实测 scoop status 约 8 秒（bucket 多 / 网络慢会更久），故给 30 秒预算。
     */
    async resync() {
      if (this.resyncing) return;
      this.resyncing = true;
      try {
        await api.post('/system/resync');
        await this.refreshAll({ force: true, refreshCache: true });
        this.reloadView();
        this.toast('已清空缓存并重新读取磁盘。', 'success');

        if (this.updatesSource !== 'status') {
          for (let attempt = 0; attempt < 6; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            await this.refreshOverview();
            if (this.updatesSource === 'status') break;
          }
        }
        if (this.updatesSource === 'status') {
          this.toast('可更新列表已更新为联网权威结果。', 'success');
        } else {
          this.toast('联网复核未在 30 秒内完成，可更新列表暂按本地 bucket 索引计算；稍后可点「检查更新状态」重试。', 'warn', 8000);
        }
      } catch (error) {
        this.toast(errorMessage(error), 'danger');
      } finally {
        this.resyncing = false;
      }
    },

    async refreshRuntime() {
      try {
        const data = await api.get('/jobs?limit=1');
        this.running = data.running ?? 0;
        this.queued = data.queued ?? 0;
      } catch {
        // 轮询失败静默处理，避免刷屏
      }
    },

    /** 只刷新 scoop 环境（用于安装/切换路径后） */
    async refreshEnvironment() {
      const data = await this.runAction(() => api.post('/scoop/env/refresh'), { silent: true });
      if (data) {
        this.env = data;
        this.toast('环境信息已刷新', 'success');
        await this.refreshAll({ silentOnboarding: true });
      }
    },

    /**
     * 清除「指定路径」写入的应用配置，回到自动检测。
     * 只在 env.rootSource === 'app-config' 时才会出现入口（见 dashboard 的 hero 区）。
     */
    async clearScoopPath() {
      const confirmed = await this.askConfirm({
        title: '恢复自动检测',
        message: '将清除本程序记录的 Scoop 根目录，改回按环境变量与默认位置自动检测。',
        detail: '只清除本程序的配置项，不会删除或移动任何文件。',
        confirmText: '恢复自动检测',
        danger: false,
      });
      if (!confirmed) return;
      const data = await this.runAction(() => api.del('/scoop/path'), { silent: true });
      if (!data) return;
      this.env = data;
      this.toast('已恢复自动检测', 'success');
      await this.refreshAll({ silentOnboarding: true });
    },

    // ------------------------------------------------------------ 引导
    openOnboarding(tab = 'install') {
      this.onboarding.open = true;
      this.onboarding.tab = tab;
      this.onboarding.error = '';
      // 带上当前生效的代理（未安装 Scoop 时来自本程序保存的值），省去重复填写
      if (!this.onboarding.proxy) {
        this.onboarding.proxy = this.proxy?.value ?? '';
      }
      if (!this.onboarding.installDir) {
        this.onboarding.installDir = 'C:\\scoop';
      }
    },

    dismissOnboarding() {
      this.onboarding.open = false;
      this.onboarding.dismissed = true;
    },

    /** 引导页里先测一下代理能不能连通，避免装到一半才发现代理不通。 */
    async testOnboardingProxy() {
      const value = this.onboarding.proxy.trim();
      if (!value) {
        this.toast('请先填写代理地址再测试。', 'warn');
        return;
      }
      this.onboarding.proxyTest = { running: true, done: false, ok: false, ms: 0, error: '', hint: '', target: null };
      try {
        const data = await api.post('/config/proxy/test', { value });
        this.onboarding.proxyTest = {
          running: false,
          done: true,
          ok: Boolean(data.ok),
          ms: data.ms ?? 0,
          error: data.error ?? '',
          hint: data.hint ?? '',
          target: data.target ?? null,
        };
      } catch (error) {
        this.onboarding.proxyTest = { running: false, done: true, ok: false, ms: 0, error: errorMessage(error), hint: '', target: null };
      }
    },

    async submitOnboardingInstall() {
      this.onboarding.busy = true;
      this.onboarding.error = '';
      try {
        const job = await api.post('/scoop/install', {
          targetDir: this.onboarding.installDir?.trim() || null,
          runAsAdmin: this.onboarding.runAsAdmin,
          proxy: this.onboarding.proxy?.trim() || null,
        });
        this.onboarding.open = false;
        this.trackJob(job.job);
      } catch (error) {
        this.onboarding.error = errorMessage(error);
      } finally {
        this.onboarding.busy = false;
      }
    },

    async submitOnboardingAttach() {
      this.onboarding.busy = true;
      this.onboarding.error = '';
      try {
        const env = await api.put('/scoop/path', { dir: this.onboarding.attachDir?.trim() });
        this.env = env;
        this.onboarding.open = false;
        this.toast('已接入指定的 Scoop 路径', 'success');
        await this.refreshAll({ silentOnboarding: true });
      } catch (error) {
        this.onboarding.error = errorMessage(error);
      } finally {
        this.onboarding.busy = false;
      }
    },

    // ------------------------------------------------------------ Toast
    toast(message, tone = 'info', ttl = 3600) {
      this.toastSeq += 1;
      const id = this.toastSeq;
      this.toasts.push({ id, message: String(message), tone });
      if (this.toasts.length > 4) this.toasts.shift();
      setTimeout(() => this.dismissToast(id), ttl);
    },

    dismissToast(id) {
      const index = this.toasts.findIndex((item) => item.id === id);
      if (index >= 0) this.toasts.splice(index, 1);
    },

    // ------------------------------------------------------------ 确认弹层
    askConfirm({ title, message, detail = '', confirmText = '确认', danger = true }) {
      return new Promise((resolve) => {
        // 上一个确认还没落定时先以「取消」结束它：
        // 直接覆盖 this.confirm 会让上一个 await 永远悬空（例如连点两次危险操作）。
        const previous = this.confirm;
        if (previous.open && typeof previous.resolve === 'function') {
          previous.resolve(false);
        }
        this.confirm = { open: true, title, message, detail, confirmText, danger, resolve };
      });
    },

    settleConfirm(value) {
      const resolver = this.confirm.resolve;
      this.confirm = { open: false, title: '', message: '', detail: '', confirmText: '确认', danger: true, resolve: null };
      if (typeof resolver === 'function') resolver(value);
    },

    // ------------------------------------------------------------ 动作封装
    /**
     * 统一处理「可能失败的动作」：成功给提示、失败给中文错误。
     * silent=true 时只返回 null，由调用方自己处理错误展示。
     */
    async runAction(action, options = {}) {
      try {
        const data = await action();
        if (options.successMessage) this.toast(options.successMessage, 'success');
        return data;
      } catch (error) {
        if (!options.silent) {
          this.toast(errorMessage(error), 'danger', options.ttl ?? 8000);
        }
        if (options.onError) options.onError(error);
        return null;
      }
    },

    /**
     * 提交任务后统一跟踪：切到任务页并开始接收实时日志。
     *
     * @param options.onDone 任务结束（成功/失败/取消）时执行一次。
     *   写操作都是「提交任务 -> scoop 异步执行」，视图里的数据不会自动更新，
     *   需要靠它在任务结束后重新拉取（例如配置开关翻转后回填真实值）。
     */
    trackJob(job, options = {}) {
      if (!job) return;
      this.running += 1;
      if (typeof options.onDone === 'function') {
        // 同一时刻只跟踪一个任务的日志流（watch 会断开上一个），
        // 因此上一个任务的 done 事件可能收不到。这里先把遗留的后置动作跑掉，
        // 免得界面一直停在乐观更新后的值上（下一个任务结束时还会再刷新一次）。
        for (const pending of jobDoneHandlers.values()) {
          try {
            pending('superseded');
          } catch (error) {
            console.error('任务后置回调执行失败', error);
          }
        }
        jobDoneHandlers.clear();
        jobDoneHandlers.set(job.id, options.onDone);
      }
      this.jobs.watch(job.id);
      void this.jobs.load();
      if (!options.stay) {
        this.setView('jobs');
        // 窄屏下日志面板在任务列表下方，切换视图后需要主动滚过去
        this.jobs.focusLog();
      }
      this.toast(options.message ?? `已提交任务：${job.title}`, 'info');
    },

    /**
     * 按安装范围拆分提交批量任务。
     *
     * scoop 的 `-g` 是「整次调用」的开关，接口也只接受一个 global 布尔，
     * 因此混选「用户 / 全局」应用时必须拆成两次请求 —— 否则全局应用会被按用户范围处理
     * （`scoop update <name>` 命中不到全局目录，表现为「跑完了但什么都没变」）。
     *
     * @param {string} path            '/apps/update' | '/apps/uninstall'
     * @param {Array<{name: string, global: boolean}>} entries
     * @param {object} body            两次请求共用的额外字段（例如 purge）
     * @returns {Promise<Array>} 已提交的任务列表
     *
     * 两次请求共用同一条串行队列，按提交顺序执行；日志面板同一时刻只能跟一条流，
     * 所以只 watch 第一个任务，其余任务在任务列表里跟进。
     */
    async submitScopedBatches(path, entries, body = {}) {
      const groups = [];
      const userApps = entries.filter((item) => !item.global).map((item) => item.name);
      const globalApps = entries.filter((item) => item.global).map((item) => item.name);
      if (userApps.length > 0) groups.push({ apps: userApps, global: false });
      if (globalApps.length > 0) groups.push({ apps: globalApps, global: true });
      if (groups.length === 0) return [];

      const jobs = [];
      for (const group of groups) {
        // 串行 await：第二批在后端排队，避免两个 scoop 同时改动同一份 bucket / 缓存
        const data = await api.post(path, { ...body, apps: group.apps, global: group.global });
        jobs.push(data.job);
        // 第一批发出去就接上日志流：万一后面的批次提交失败，
        // 已经提交的那批仍然是被跟踪的，不会变成"没人看的孤儿任务"
        if (jobs.length === 1) this.trackJob(data.job);
      }

      if (jobs.length > 1) {
        const queued = groups.slice(1).reduce((sum, group) => sum + group.apps.length, 0);
        this.toast(`已按安装范围拆成 ${jobs.length} 批：先执行 ${groups[0].apps.length} 个，其余 ${queued} 个排队依次执行。`, 'info', 6000);
      }
      return jobs;
    },

    /** 由任务视图在收到 done 事件时回调，执行 trackJob 注册的后置动作。 */
    notifyJobDone(id, status) {
      const handler = jobDoneHandlers.get(id);
      if (!handler) return;
      jobDoneHandlers.delete(id);
      try {
        handler(status);
      } catch (error) {
        console.error('任务后置回调执行失败', error);
      }
    },

    // ------------------------------------------------------------ 小工具
    async copyText(text) {
      const value = String(text ?? '');
      if (!value) return;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(value);
        } else {
          throw new Error('clipboard unavailable');
        }
        this.toast('已复制到剪贴板', 'success', 1800);
      } catch {
        // 非安全上下文（例如通过局域网 IP 访问）下降级为 execCommand
        try {
          const area = document.createElement('textarea');
          area.value = value;
          area.setAttribute('readonly', 'readonly');
          area.style.position = 'fixed';
          area.style.opacity = '0';
          document.body.appendChild(area);
          area.select();
          document.execCommand('copy');
          document.body.removeChild(area);
          this.toast('已复制到剪贴板', 'success', 1800);
        } catch {
          this.toast('复制失败，请手动选择文本', 'warn');
        }
      }
    },

    errorDetailOf(error) {
      return errorDetail(error);
    },

    /** 外链过滤：模板里绑 href 的第三方地址（homepage / bucket source）都要过这一层 */
    externalUrl(value) {
      return externalUrl(value);
    },

    /**
     * 打开外部链接。
     *
     * 桌面端的 WebView 不处理 `target="_blank"`（点了没有任何反应），必须走 Rust 侧的
     * `open_external` 命令；服务/浏览器模式退回新标签页。两条路径都只放行 http(s)，
     * 因为 homepage / bucket source 都来自第三方内容。
     *
     * @returns {boolean} 是否真的打开了（false 表示没有可用链接）
     */
    openExternal(value) {
      const target = externalUrl(value);
      if (!target) return false;

      const invoke = TAURI?.core?.invoke;
      if (IS_DESKTOP && typeof invoke === 'function') {
        Promise.resolve(invoke('open_external', { url: target })).catch((error) => {
          // 命令被拒绝（例如能力校验不通过）时不静默失败，否则用户只会觉得"点了没反应"
          this.toast(`无法打开链接：${error?.message ?? error}`, 'warn');
        });
        return true;
      }

      window.open(target, '_blank', 'noopener,noreferrer');
      return true;
    },

    // ------------------------------------------------------------ 桌面窗口控制
    // 这些方法只有 isDesktop=true 才会在模板里出现；浏览器调用时直接 no-op。
    windowMinimize() {
      const handle = getWin();
      if (!handle) return;
      void handle.minimize().catch(() => {});
    },

    windowToggleMaximize() {
      const handle = getWin();
      if (!handle) return;
      void handle.toggleMaximize().catch(() => {});
    },

    /**
     * 关闭按钮：与 Rust 侧 on_window_event CloseRequested 协作。
     *
     * Rust 里对 CloseRequested 做了 api.prevent_close() + hide() ——
     * 它把「点 X」解释为「最小化到托盘」，从而让后台 scoop 任务继续跑。
     *
     * 前端调 window.close() 会再次触发 CloseRequested 走同一路径，
     * 所以最终效果仍是"隐藏到托盘"，这正是我们想要的：
     * 自绘标题栏的关闭按钮与系统原生关闭按钮行为完全一致，都不杀进程。
     */
    windowClose() {
      const handle = getWin();
      if (!handle) return;
      void handle.close().catch(() => {});
    },
  };

  return shell;
}

/** 组装所有视图并注册到 Alpine。 */
function register() {
  if (!window.Alpine) return;
  window.Alpine.data('app', () => {
    // ⚠️ 这里必须让「模板」与「视图」读写同一个响应式对象。
    //
    // 若写成 `{ ...shell, dashboard: createDashboard(shell) }`，展开会复制出一份
    // 普通属性：模板改的是副本，而视图闭包读的是原始对象 —— 视图里的 getter
    // 既收集不到依赖、也拿不到最新值（表现为指标卡恒为 0、体检清单恒为空）。
    //
    // 因此先用 Alpine.reactive 把 shell 变成响应式代理，再挂上各视图，
    // 保证数据只有一个来源。Alpine 对已是代理的对象不会重复包装。
    const shell = window.Alpine.reactive(createShell());
    return Object.assign(shell, {
      dashboard: createDashboard(shell),
      installed: createInstalled(shell),
      discover: createDiscover(shell),
      buckets: createBuckets(shell),
      config: createConfigView(shell),
      jobs: createJobs(shell),
    });
  });

  // 自绘下拉框（替代原生 <select>）。
  //
  // 原生 <select> 的弹出层由操作系统绘制：即使页面声明了 color-scheme: dark，
  // Windows 上仍是亮色菜单，与整体主题不符，且 CSS 无法干预弹出层。
  //
  // 这里用「按钮 + listbox」自绘。选中值通过 getter/setter 绑到父级属性 ——
  // 内置的 Alpine 构建不支持 x-modelable（vendor 里没有该实现），所以不用它。
  window.Alpine.data('selectField', (getOptions, target, prop) => ({
    open: false,
    highlighted: -1,

    get options() {
      const list = typeof getOptions === 'function' ? getOptions() : Array.isArray(getOptions) ? getOptions : [];
      return list.map((item) => (typeof item === 'string' ? { value: item, label: item } : item));
    },

    // getter/setter 直接读写父级的响应式属性，等价于 x-model
    get value() {
      return target ? target[prop] : '';
    },

    set value(next) {
      if (target) target[prop] = next;
    },

    get label() {
      const current = this.options.find((option) => option.value === this.value);
      return current ? current.label : this.options[0]?.label ?? '请选择';
    },

    init() {
      // 打开时把键盘高亮定位到当前选中项
      this.$watch('open', (isOpen) => {
        if (!isOpen) return;
        const index = this.options.findIndex((option) => option.value === this.value);
        this.highlighted = index >= 0 ? index : 0;
      });
    },

    toggle() {
      this.open = !this.open;
    },

    choose(option) {
      const changed = this.value !== option.value;
      this.value = option.value;
      this.open = false;
      // 有些用法在父级监听 @change 触发搜索/刷新，值真正变化时才派发
      if (changed) this.$el.dispatchEvent(new Event('change', { bubbles: true }));
    },

    onKeydown(event) {
      if (event.key === 'Escape') {
        this.open = false;
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      const count = this.options.length;
      if (count === 0) return;
      if (event.key === 'Enter' || event.key === ' ') {
        if (this.open) {
          const option = this.options[this.highlighted];
          if (option) this.choose(option);
        } else {
          this.open = true;
        }
        return;
      }
      if (!this.open) {
        this.open = true;
        return;
      }
      this.highlighted = event.key === 'ArrowDown' ? (this.highlighted + 1) % count : (this.highlighted - 1 + count) % count;
    },
  }));

  // boot.js 已把 Alpine 的自动 start 挂起（Alpine v3 移除了 deferLoadingAlpine），
  // 必须等组件注册完成后由这里显式放行，否则 x-data="app" 会解析失败。
  if (typeof window.__releaseAlpine === 'function') {
    window.__releaseAlpine();
  } else {
    window.Alpine.start();
  }
}

/**
 * Alpine 是 defer 加载的，而本模块是 module（同样是 defer）。
 * boot.js 已拦截其自动启动，所以这里只需等 window.Alpine 出现即可安全注册，
 * 不必担心「注册晚于 start」的竞态。
 */
function whenAlpine(callback) {
  if (window.Alpine) {
    callback();
    return;
  }
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    if (window.Alpine) {
      clearInterval(timer);
      callback();
    } else if (attempts > 200) {
      clearInterval(timer);
      document.body.innerHTML =
        '<div style="padding:40px;font-family:sans-serif;color:#E8EEF9;background:#0B0F16;height:100vh">' +
        '<h2>Alpine.js 未能加载</h2><p>请确认 public/vendor/alpine.min.js 存在且未被拦截。</p></div>';
    }
  }, 16);
}

whenAlpine(register);
