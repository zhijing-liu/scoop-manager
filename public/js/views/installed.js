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
    /** 只看有状态问题的应用（缺依赖 / 安装失败 / 清单缺失） */
    onlyIssues: false,
    /** 状态问题的数据来源：{ source: 'status' | 'scan', checkedAt: number | null } */
    health: { source: 'scan', checkedAt: null },
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
        // 缺依赖 / 安装失败等状态随列表一起返回，来源决定提示文案（权威 or 本地比对）
        this.health = data.health ?? { source: 'scan', checkedAt: null };
        // 选中项按 key 收敛：应用被卸载 / 换了范围后要自动从选中集合里移除
        const alive = new Set(this.items.map((item) => this.selectionKey(item)));
        this.selected = this.selected.filter((key) => alive.has(key));
        // 保证「可更新」角标可用。
        // 但静默后台刷新（silent=true，由 refreshAll 派生）绝不能走这里 ——
        // 那会形成 refreshAll → installed.load → refreshAll 的相互递归，
        // 表现为顶栏刷新按钮的禁用态疯狂闪烁。走到这里时全局数据刚刚刷过，
        // 本来也不需要再刷一次。
        if (!silent && (!shell.counts || (shell.updates?.length ?? 0) === 0)) {
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
      return Boolean(this.query.trim()) || this.scope !== 'all' || this.onlyUpdatable || this.onlyIssues;
    },

    clearFilters() {
      this.query = '';
      this.scope = 'all';
      this.onlyUpdatable = false;
      this.onlyIssues = false;
    },

    // ---------------------------------------------------------------- 状态问题

    /**
     * 应用是否有状态问题。
     *
     * 这三个字段来自 /apps（不是前端自己算的）：
     *   installFailed   —— 目录在但 install.json 读不出来（= scoop status 的 "Install failed"）
     *   manifestRemoved —— current 下没有 manifest.json
     *   missingDeps     —— 依赖里有没装的应用（与 Scoop 一致，按应用名比对）
     */
    hasIssue(app) {
      return Boolean(app && (app.installFailed || app.manifestRemoved || (app.missingDeps?.length ?? 0) > 0));
    },

    /** 有状态问题的应用数，用于筛选按钮上的计数 */
    get issueCount() {
      return this.items.filter((item) => this.hasIssue(item)).length;
    },

    /** 状态问题的来源说明（放进提示文案，避免用户以为数据一定权威） */
    get healthNote() {
      return this.health.source === 'status'
        ? '来自 scoop status 的权威结果。'
        : '按本地 bucket 清单比对得出，bucket 未更新时可能滞后；点「检查更新状态」可获得 scoop status 的权威结果。';
    },

    /**
     * 修复建议：把应用的状态问题翻译成可复制执行的命令 + 一句人话解释。
     * @returns {{ commands: string[], hint: string }}
     */
    repairPlan(app) {
      const commands = [];
      const hints = [];
      if (app.installFailed) {
        // 这里刻意不给 `scoop uninstall`：残骸状态下 Scoop 认为它"未安装"，
        // 该命令只会打印 "ERROR 'xxx' isn't installed." 然后退 0，等于什么都没做。
        // app.path 是 current 目录，父目录才是 apps\<name>
        const appDir = String(app.path ?? '').replace(/[\\/]current$/, '');
        commands.push(`scoop install ${app.name}`);
        hints.push(
          '安装不完整：目录在但读不到 install.json。Scoop 因此认为它"未安装"，'
          + `scoop uninstall 对它无效 —— 底部的删除按钮已自动变为「清理残骸」，点它即可`
          + `（或手动删除 ${appDir}）后再重新安装。`,
        );
      }
      if (app.manifestRemoved) {
        hints.push('本地读不到该应用的 manifest（清单已从 bucket 移除或安装中断），重新安装前请确认它仍在某个 bucket 中。');
      }
      if ((app.missingDeps?.length ?? 0) > 0) {
        commands.push(`scoop install ${app.missingDeps.join(' ')}`);
        hints.push(`缺少依赖 ${app.missingDeps.join('、')}：Scoop 按应用名校验，系统里已有同名命令（例如 Windows 自带的 sudo.exe）依然算缺失。`);
      }
      return { commands, hint: hints.join(' ') };
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

      if (this.onlyIssues) {
        list = list.filter((item) => this.hasIssue(item));
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

      // 残骸不能混进批量：`scoop uninstall` 对它无效（Scoop 认为它"未安装"），
      // 提交了只会得到"批量跑完了但什么都没发生"。这里先摘出来说明白，
      // 让用户用「只看异常」筛出来后逐个走「清理残骸」。
      const remains = entries.filter((item) => item.installFailed);
      const removable = entries.filter((item) => !item.installFailed);
      if (removable.length === 0) {
        shell.toast(`选中的 ${remains.length} 个应用都是安装残骸，scoop 无法卸载：请用「只看异常」筛出后逐个「清理残骸」。`, 'warn', 8000);
        return;
      }

      const names = removable.map((item) => item.name);
      const confirmed = await shell.askConfirm({
        title: '批量卸载',
        message: `将卸载选中的 ${names.length} 个应用：${names.slice(0, 8).join('、')}${names.length > 8 ? ' 等' : ''}。`
          + (remains.length > 0 ? `\n其中 ${remains.length} 个是安装残骸，会被跳过（需逐个「清理残骸」）。` : ''),
        detail: '卸载后可通过「搜索与安装」重新安装。持久化数据（persist 目录）会一并删除，不可恢复。',
        confirmText: '卸载',
        danger: true,
      });
      if (!confirmed) return;
      this.batchBusy = true;
      try {
        // 同 batchUpdate：按范围拆开提交，全局应用需要 -g 才能被命中。
        // purge 必须显式传：不传的话后端默认 false，批量卸载会残留 persist 数据，
        // 与单行卸载（固定 -p）行为不一致。
        await shell.submitScopedBatches('/apps/uninstall', removable, { purge: true });
        this.clearSelection();
        if (remains.length > 0) {
          shell.toast(`已提交 ${removable.length} 个卸载；另有 ${remains.length} 个残骸被跳过，请逐个「清理残骸」。`, 'warn', 8000);
        }
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

    /**
     * 卸载按钮的文案：残骸下同一个按钮就是「清理残骸」。
     *
     * 不做成两个按钮：残骸本来就是「卸载失败留下的东西」，用户的心智模型是
     * "我要把这个删掉" —— 让他在两个位置之间找按钮是设计失误。按钮文案与行为
     * 一起按状态切换，位置保持不动。
     */
    removeLabel(app) {
      return app?.installFailed ? '清理残骸' : '卸载';
    },

    /** 卸载按钮的 tooltip：把"为什么是清理残骸"讲清楚 */
    removeTitle(app) {
      return app?.installFailed
        ? '安装残骸：Scoop 认为它未安装，uninstall 无效，这里会直接删除目录 / shim / 用户数据'
        : '卸载';
    },

    /**
     * 删除入口（列表行与详情抽屉共用）。
     *
     * 残骸必须先转成清理：Scoop 以 install.json 判断"是否安装"，残骸读不出
     * install.json → `scoop uninstall` 只打印 "ERROR 'xxx' isn't installed."
     * 然后退 0（什么都不做），提交任务只会得到一条"假成功"。
     */
    async uninstall(app) {
      if (app.installFailed) {
        await this.cleanRemains(app);
        return;
      }
      const confirmed = await shell.askConfirm({
        title: `卸载 ${app.name}`,
        message: `将卸载 ${app.name}${app.version ? ` v${app.version}` : ''}，并删除它的持久化数据。`,
        detail: '如果该应用被其他应用依赖，可能导致依赖它的程序无法运行。持久化数据（persist 目录）会一并删除，不可恢复。',
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

    /**
     * 清理安装残骸。
     *
     * 残骸是 Scoop 自身的一处死锁：`scoop status` 按目录遍历认它、
     * `scoop uninstall` 按 install.json 不认它，于是「卸载」永远无效。
     * 这里按 Scoop 卸载时相同的方式清理（应用目录 + shim + persist）。
     */
    async cleanRemains(app) {
      const confirmed = await shell.askConfirm({
        title: `清理安装残骸 ${app.name}`,
        message: `将删除 ${String(app.path ?? '').replace(/[\\/]current$/, '')}、它留下的 shim 命令，以及 persist 里的用户数据。`,
        detail: '该应用已是安装残骸：Scoop 认为它"未安装"，scoop uninstall 对它无效，scoop status 里会一直显示 Install failed。此操作不可恢复。',
        confirmText: '清理残骸',
        danger: true,
      });
      if (!confirmed) return;
      this.busyName = app.name;
      try {
        const data = await api.post('/apps/remains', { name: app.name, purge: true });
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
