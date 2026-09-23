/**
 * 日志建议规则自测。
 *
 * 为什么需要它
 * ────────────
 * 规则跑在**每一条**日志上，误报的代价是给出一个错误的操作按钮（例如让用户去
 * 添加一个其实不缺的 bucket），比漏报更糟。而规则本身是正则，改一字就可能
 * 全盘失守，所以这里既喂真实报错文本（回归），也喂正常输出（误报护栏）。
 *
 * 用例里的报错文本全部来自真机日志，未做改写（除了把路径替换为通用路径）。
 *
 * 用法：bun run test:hints
 */

import { HINT_RULES, MAX_HINTS_PER_JOB, createHintDetector } from '../src/jobs/hints.js';
import type { JobHint } from '../src/jobs/types.js';

const failures: string[] = [];
let passed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  \u001b[32mPASS\u001b[0m  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u001b[31mFAIL\u001b[0m  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 逐行喂给一个全新的扫描器，返回产出（模拟 JobManager.log 的调用方式） */
function scan(lines: string[], initial: JobHint[] = []): JobHint[] {
  const detect = createHintDetector(initial);
  const found: JobHint[] = [];
  for (const line of lines) {
    const hint = detect(line);
    if (hint) found.push(hint);
  }
  return found;
}

// ---------------------------------------------------------------- 真实日志片段

/**
 * 本机实际输出（bilibili 1.18.0 → 1.19.0）。
 *
 * 第 2–4 行是第 1 行的连锁反应：模块没加载成功，模块里定义的命令自然不存在。
 * 因此只应产出一条建议 —— 报四条等于把同一个问题说四遍。
 */
const REAL_BILIBILI_STDERR = [
  'Import-Module : 未能加载指定的模块“G:\\scoop\\buckets\\dorado\\scripts\\DoradoUtils.psm1”，因为在任何模块目录中都没有找到有效模块文件。',
  '所在位置 行:3 字符: 1',
  '+ Import-Module $(Join-Path $(Find-BucketDirectory -Root -Name dorado)  ...',
  'Mount-ExternalRuntimeData : 无法将“Mount-ExternalRuntimeData”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。请检查名称的拼写，如果包括路径，请确保路径正确，然后再试一次。',
  'Remove-Module : 没有删除任何模块。请确认要删除的模块的规范正确，并且运行空间中存在这些模块。',
  'Dismount-ExternalRuntimeData : 无法将“Dismount-ExternalRuntimeData”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。',
];

/** 同一次任务里的正常输出：一条建议都不该产出 */
const NORMAL_OUTPUT = [
  "Updating 'bilibili' (1.18.0 -> 1.19.0)",
  "Installing 'bilibili' (1.19.0) [64bit] from 'third' bucket",
  'Loading app-64.7z from cache',
  'Extracting app-64.7z ... done.',
  'Running installer script...done.',
  'Linking G:\\scoop\\apps\\bilibili\\current => G:\\scoop\\apps\\bilibili\\1.19.0',
  'Creating shortcut for 哔哩哔哩 (哔哩哔哩.exe)',
  "Checking hash of clash-party-windows-2.0.3-x64-portable.7z ... ok.",
  'Persisting data',
  "Unlinking G:\\scoop\\apps\\clash-party\\current",
  "'clash-party' (2.0.3) was installed successfully!",
  'Checking remote manifest...',
  'WARN  Scoop is out of date. Run `scoop update` to update.',
];

// ---------------------------------------------------------------- 用例

console.log('\n日志建议规则自测\n');

// ---- 1. 真实报错：缺 bucket 的脚本模块
{
  const hints = scan(REAL_BILIBILI_STDERR);
  const hint = hints[0];
  check('真实报错产出恰好一条建议（连锁报错不重复报）', hints.length === 1, `实际 ${hints.length} 条`);
  check('规则与去重键正确', hint?.id === 'bucket-helper-missing:dorado', hint?.id ?? '(无)');
  check('级别为 warn（有步骤没做成）', hint?.level === 'warn', hint?.level ?? '(无)');
  check('识别出 bucket 名', hint?.action?.kind === 'bucket.add' && hint?.action?.bucket === 'dorado', JSON.stringify(hint?.action));
  check('按钮文案带 bucket 名', typeof hint?.action?.label === 'string' && hint.action.label.includes('dorado'), hint?.action?.label ?? '(无)');
  check('标题提到 bucket 名', Boolean(hint?.title.includes('dorado')), hint?.title ?? '(无)');
  check('说明里带上了模块文件名', Boolean(hint?.message.includes('DoradoUtils.psm1')), hint?.message ?? '(无)');
  check('说明里点明"这一步被跳过"而非任务失败', Boolean(hint?.message.includes('跳过')), hint?.message ?? '(无)');
}

// ---- 2. 误报护栏：正常输出必须一条都不产出
{
  const hints = scan(NORMAL_OUTPUT);
  check('正常输出零误报', hints.length === 0, JSON.stringify(hints.map((h) => h.id)));
}

// ---- 3. 其它规则的基本触发
{
  // id 形如 `<规则id>` 或 `<规则id>:<关键词>`（关键词来自捕获组，用于区分不同 bucket / 应用）
  const cases: Array<{ line: string; id: string; level: string }> = [
    { line: "Couldn't find manifest for 'bilibili'.", id: 'manifest-missing', level: 'warn' },
    { line: 'ERROR Hash check failed!', id: 'hash-mismatch', level: 'warn' },
    { line: 'ERROR Download failed!', id: 'network-failure', level: 'info' },
    { line: "fatal: unable to access 'https://github.com/x/y/': Recv failure: Connection was reset", id: 'network-failure', level: 'info' },
    { line: 'Remove-Item : 拒绝访问。', id: 'permission-denied', level: 'info' },
    { line: 'Access is denied.', id: 'permission-denied', level: 'info' },
  ];
  for (const item of cases) {
    const hints = scan([item.line]);
    const hit = hints.length === 1 && (hints[0].id === item.id || hints[0].id.startsWith(`${item.id}:`));
    check(`命中 ${item.id}：${item.line.slice(0, 42)}…`, hit, JSON.stringify(hints.map((h) => h.id)));
    check(`  ${item.id} 级别为 ${item.level}`, hints[0]?.level === item.level, hints[0]?.level ?? '(无)');
  }
}

// ---- 4. 建议必须带可执行的下一步
{
  const withAction = [
    "Couldn't find manifest for 'foo'.",
    'ERROR Hash check failed!',
    'ERROR Download failed!',
    'Import-Module : 未能加载指定的模块“C:\\scoop\\buckets\\dorado\\scripts\\DoradoUtils.psm1”',
  ];
  const missing = withAction.filter((line) => !scan([line])[0]?.action);
  check('以上每条建议都带一键操作', missing.length === 0, JSON.stringify(missing));

  const viewActions = scan(["Couldn't find manifest for 'foo'.", 'ERROR Hash check failed!', 'ERROR Download failed!']).map((h) => h.action?.view);
  check('跳转类动作指向存在的视图', JSON.stringify(viewActions) === JSON.stringify(['buckets', 'dashboard', 'config']), JSON.stringify(viewActions));
}

// ---- 5. 去重：同一问题只报一次，不同关键词各报一次
{
  const twice = scan([REAL_BILIBILI_STDERR[0], REAL_BILIBILI_STDERR[0]]);
  check('同一行重复出现只报一条', twice.length === 1, `实际 ${twice.length} 条`);

  const twoBuckets = scan([
    'Import-Module : 未能加载指定的模块“C:\\scoop\\buckets\\alpha\\scripts\\A.psm1”',
    'Import-Module : 未能加载指定的模块“C:\\scoop\\buckets\\beta\\scripts\\B.psm1”',
  ]);
  check('两个不同 bucket 各报一条', twoBuckets.length === 2, `实际 ${twoBuckets.length} 条`);
  check('去重键按 bucket 区分', JSON.stringify(twoBuckets.map((h) => h.id)) === '["bucket-helper-missing:alpha","bucket-helper-missing:beta"]', JSON.stringify(twoBuckets.map((h) => h.id)));
}

// ---- 6. 从 jobs.json 恢复后不重复产出
{
  const existing = scan(REAL_BILIBILI_STDERR);
  const again = scan(REAL_BILIBILI_STDERR, existing);
  check('带已有建议恢复时不重复产出', again.length === 0, `实际 ${again.length} 条`);
}

// ---- 7. 规则表自身的约束
{
  check('每条规则都有 id 与级别', HINT_RULES.every((rule) => Boolean(rule.id) && (rule.level === 'warn' || rule.level === 'info')));
  check('规则 id 不重复', new Set(HINT_RULES.map((rule) => rule.id)).size === HINT_RULES.length);

  // 只为防止以后有人给规则加上 /g（exec 会带 lastIndex，隔行失效）
  check('规则不使用 /g 标志（否则 exec 的 lastIndex 会让它隔行失效）', HINT_RULES.every((rule) => !rule.pattern.global));

  // 一条规则命中后不应该影响其它规则继续扫描
  const shared = scan(['ERROR Download failed!', 'ERROR Hash check failed!', 'ERROR Download failed!']);
  check('命中一条规则后仍继续扫描其它规则', shared.length === 2, `实际 ${shared.length} 条`);
}

// ---- 8. 上限
{
  const many: string[] = [];
  for (let index = 0; index < MAX_HINTS_PER_JOB + 3; index += 1) {
    many.push(`Import-Module : 未能加载指定的模块“C:\\scoop\\buckets\\b${index}\\scripts\\M${index}.psm1”`);
  }
  const hints = scan(many);
  check(`产出封顶在 ${MAX_HINTS_PER_JOB} 条`, hints.length === MAX_HINTS_PER_JOB, `实际 ${hints.length} 条`);

  // 已恢复的建议要计入上限，否则重启后能再攒一批
  const restored = scan(many, scan(many));
  check('已恢复的建议计入上限', restored.length === 0, `实际 ${restored.length} 条`);
}

console.log(`\n结果：${passed} 项通过，${failures.length} 项失败`);
if (failures.length > 0) {
  console.log('\n失败明细：');
  for (const item of failures) console.log(`  - ${item}`);
  process.exit(1);
}
console.log('日志建议规则自测全部通过。\n');
