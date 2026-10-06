import { db } from './db';
import { getSyncBase, setSyncBase } from './revision';
import { recalcRecheckDiffs } from './recheckCalc';
import type { Plot } from '../types/plot';
import type { TreeRecord } from '../types/tree';
import type { RegenShrub } from '../types/regen';

export const EXCHANGE_FORMAT = 'gbforestplot-exchange';
export const EXCHANGE_VERSION = 1;

/** 离线交换包（JSON 文件） */
export interface ExchangePackage {
  format: typeof EXCHANGE_FORMAT;
  version: number;
  exportedAt: number;
  source: { device?: string; crew?: string };
  plots: ExchangePlot[];
}

/** 单个样地的交换数据：当前状态 + 导出方最近同步基线 */
export interface ExchangePlot {
  plot: Plot;
  trees: TreeRecord[];
  regens: RegenShrub[];
  base: {
    revision: number;
    trees: TreeRecord[];
    regens: RegenShrub[];
  };
}

/* ----------------------------- 合并报告类型 ----------------------------- */

export interface FieldDiff {
  field: string;
  label: string;
  local: unknown;
  remote: unknown;
}

export interface TreeConflict {
  key: string;
  round: number;
  treeNo: string;
  species: string;
  local: TreeRecord;
  remote: TreeRecord;
  fieldDiffs: FieldDiff[];
}

export interface TreeChange {
  key: string;
  round: number;
  treeNo: string;
  species: string;
  changes: string[];
}

export interface RegenConflict {
  key: string;
  layer: string;
  species: string;
  round: number;
  local: RegenShrub;
  remote: RegenShrub;
  fieldDiffs: FieldDiff[];
}

export interface RegenChange {
  key: string;
  layer: string;
  species: string;
  round: number;
}

export type PlotMergeStatus = 'merged' | 'stale' | 'error';

export interface PlotMergeReport {
  /** 本机样地 id（合并后） */
  plotId: string;
  plotNo: string;
  status: PlotMergeStatus;
  localRevision: number;
  packageRevision: number;
  addedTrees: TreeChange[];
  updatedTrees: TreeChange[];
  conflictTrees: TreeConflict[];
  addedRegens: RegenChange[];
  updatedRegens: RegenChange[];
  conflictRegens: RegenConflict[];
  notes: string[];
  /** 旧包失效时列出的受影响对象 */
  affected: { kind: 'plot' | 'tree' | 'regen'; id: string; desc: string }[];
  error?: string;
}

export interface MergedPlot {
  localPlotId: string;
  plotNo: string;
  isNew: boolean;
  nextPlot: Plot;
  nextTrees: TreeRecord[];
  nextRegens: RegenShrub[];
  report: PlotMergeReport;
}

/* ----------------------------- 工具函数 ----------------------------- */

function treeKey(t: TreeRecord): string {
  return `${t.round}__${t.treeNo}`;
}
function regenKey(r: RegenShrub): string {
  return `${r.round}__${r.layer}__${r.species}`;
}

const TREE_COMPARE_FIELDS: { field: keyof TreeRecord; label: string }[] = [
  { field: 'species', label: '树种' },
  { field: 'dbhCm', label: '胸径' },
  { field: 'heightM', label: '树高' },
  { field: 'underBranchH', label: '枝下高' },
  { field: 'crownWidth', label: '冠幅' },
  { field: 'status', label: '状态' },
  { field: 'origin', label: '起源' },
  { field: 'healthClass', label: '健康等级' },
  { field: 'tiltDeg', label: '倾斜度' },
  { field: 'remark', label: '位置描述' },
];

const REGEN_COMPARE_FIELDS: { field: keyof RegenShrub; label: string }[] = [
  { field: 'species', label: '种类' },
  { field: 'heightCm', label: '高度' },
  { field: 'count', label: '株数' },
  { field: 'ageGroup', label: '苗龄组' },
  { field: 'distribution', label: '分布' },
  { field: 'browseDamage', label: '啃食情况' },
];

function diffFields<T extends object>(a: T, b: T, fields: { field: keyof T; label: string }[]): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const f of fields) {
    const av = a[f.field];
    const bv = b[f.field];
    if (av !== bv) out.push({ field: String(f.field), label: f.label, local: av, remote: bv });
  }
  return out;
}

function treeDataEqual(a: TreeRecord, b: TreeRecord): boolean {
  return diffFields(a, b, TREE_COMPARE_FIELDS).length === 0;
}
function regenDataEqual(a: RegenShrub, b: RegenShrub): boolean {
  return diffFields(a, b, REGEN_COMPARE_FIELDS).length === 0;
}

function describeTreeChange(base: TreeRecord | undefined, next: TreeRecord): string[] {
  if (!base) return ['新增'];
  return diffFields(base, next, TREE_COMPARE_FIELDS).map((d) => `${d.label} ${String(d.local)} → ${String(d.remote)}`);
}

/** 旧数据按新结构升级：补齐修订号等字段 */
function upgradeTree(raw: Partial<TreeRecord>): TreeRecord {
  return {
    id: raw.id ?? '',
    plotId: raw.plotId ?? '',
    treeNo: raw.treeNo ?? '',
    species: raw.species ?? '',
    dbhCm: Number(raw.dbhCm ?? 0),
    heightM: Number(raw.heightM ?? 0),
    underBranchH: Number(raw.underBranchH ?? 0),
    crownWidth: Number(raw.crownWidth ?? 0),
    status: (raw.status as TreeRecord['status']) ?? '活立木',
    origin: (raw.origin as TreeRecord['origin']) ?? '天然',
    healthClass: (raw.healthClass as TreeRecord['healthClass']) ?? '健康',
    tiltDeg: Number(raw.tiltDeg ?? 0),
    remark: raw.remark ?? '',
    round: Number(raw.round ?? 1),
    measuredAt: Number(raw.measuredAt ?? Date.now()),
    rev: Number(raw.rev ?? 1),
  };
}

function upgradeRegen(raw: Partial<RegenShrub>): RegenShrub {
  return {
    id: raw.id ?? '',
    plotId: raw.plotId ?? '',
    layer: (raw.layer as RegenShrub['layer']) ?? '更新苗',
    species: raw.species ?? '',
    heightCm: Number(raw.heightCm ?? 0),
    count: Number(raw.count ?? 0),
    ageGroup: raw.ageGroup ?? '2 年生',
    distribution: (raw.distribution as RegenShrub['distribution']) ?? '均匀',
    browseDamage: (raw.browseDamage as RegenShrub['browseDamage']) ?? '无',
    round: Number(raw.round ?? 1),
    rev: Number(raw.rev ?? 1),
    updatedAt: Number(raw.updatedAt ?? Date.now()),
  };
}

function upgradePlot(raw: Partial<Plot>): Plot {
  return {
    id: raw.id ?? '',
    plotNo: raw.plotNo ?? '',
    locality: raw.locality ?? '',
    lng: Number(raw.lng ?? 0),
    lat: Number(raw.lat ?? 0),
    shape: (raw.shape as Plot['shape']) ?? '方形',
    area: Number(raw.area ?? 0),
    elevation: Number(raw.elevation ?? 0),
    slope: Number(raw.slope ?? 0),
    aspect: raw.aspect ?? '',
    forestType: raw.forestType ?? '',
    canopyDensity: Number(raw.canopyDensity ?? 0),
    dominantSpecies: raw.dominantSpecies ?? '',
    surveyRound: Number(raw.surveyRound ?? 1),
    surveyedAt: Number(raw.surveyedAt ?? Date.now()),
    crew: raw.crew ?? '',
    locked: Boolean(raw.locked ?? false),
    revision: Number(raw.revision ?? 1),
    createdAt: Number(raw.createdAt ?? Date.now()),
  };
}

/* ----------------------------- 交换包构建 ----------------------------- */

/** 构建单个样地的交换数据（base 取本机最近同步基线） */
export async function buildExchangePlot(plot: Plot): Promise<ExchangePlot> {
  const [trees, regens, base] = await Promise.all([
    db.trees.where('plotId').equals(plot.id).toArray(),
    db.regens.where('plotId').equals(plot.id).toArray(),
    getSyncBase(plot.id),
  ]);
  return {
    plot,
    trees,
    regens,
    base: {
      revision: base?.revision ?? 0,
      trees: base?.trees ?? [],
      regens: base?.regens ?? [],
    },
  };
}

/** 构建离线交换包 */
export async function buildPackage(plots: Plot[], source: { device?: string; crew?: string }): Promise<ExchangePackage> {
  const exchangePlots: ExchangePlot[] = [];
  for (const plot of plots) {
    exchangePlots.push(await buildExchangePlot(plot));
  }
  return {
    format: EXCHANGE_FORMAT,
    version: EXCHANGE_VERSION,
    exportedAt: Date.now(),
    source,
    plots: exchangePlots,
  };
}

/* ----------------------------- 解析与升级 ----------------------------- */

/** 解析 JSON 文本为交换包，校验格式并把旧数据升级到新结构 */
export function parsePackage(text: string): ExchangePackage {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('交换包不是合法 JSON 文件');
  }
  if (!raw || typeof raw !== 'object') throw new Error('交换包内容为空');
  const pkg = raw as Partial<ExchangePackage>;
  if (pkg.format !== EXCHANGE_FORMAT) throw new Error('文件格式不是森林样地交换包（format 不匹配）');
  if (!Array.isArray(pkg.plots) || pkg.plots.length === 0) throw new Error('交换包中没有样地数据');

  const plots: ExchangePlot[] = pkg.plots.map((epRaw) => {
    const ep = epRaw as Partial<ExchangePlot>;
    if (!ep.plot || typeof ep.plot !== 'object') throw new Error('交换包缺少样地信息');
    const plot = upgradePlot(ep.plot as Partial<Plot>);
    const trees = Array.isArray(ep.trees) ? ep.trees.map((t) => upgradeTree(t as Partial<TreeRecord>)) : [];
    const regens = Array.isArray(ep.regens) ? ep.regens.map((r) => upgradeRegen(r as Partial<RegenShrub>)) : [];
    const baseRaw = (ep.base ?? {}) as Partial<ExchangePlot['base']>;
    const base = {
      revision: Number(baseRaw.revision ?? 0),
      trees: Array.isArray(baseRaw.trees) ? baseRaw.trees.map((t) => upgradeTree(t as Partial<TreeRecord>)) : [],
      regens: Array.isArray(baseRaw.regens) ? baseRaw.regens.map((r) => upgradeRegen(r as Partial<RegenShrub>)) : [],
    };
    // 归一：所有记录 plotId 指向包内样地
    trees.forEach((t) => (t.plotId = plot.id));
    regens.forEach((r) => (r.plotId = plot.id));
    base.trees.forEach((t) => (t.plotId = plot.id));
    base.regens.forEach((r) => (r.plotId = plot.id));
    return { plot, trees, regens, base };
  });

  return {
    format: EXCHANGE_FORMAT,
    version: EXCHANGE_VERSION,
    exportedAt: Number(pkg.exportedAt ?? Date.now()),
    source: pkg.source ?? {},
    plots,
  };
}

/* ----------------------------- 三方合并 ----------------------------- */

function keyed<T>(rows: T[], keyOf: (t: T) => string): Map<string, T> {
  const m = new Map<string, T>();
  rows.forEach((r) => m.set(keyOf(r), r));
  return m;
}

/** 合并单个已有样地（local 为本机，remote 为交换包） */
function mergeExistingPlot(
  local: { plot: Plot; trees: TreeRecord[]; regens: RegenShrub[] },
  remote: ExchangePlot,
): MergedPlot {
  const report: PlotMergeReport = {
    plotId: local.plot.id,
    plotNo: local.plot.plotNo,
    status: 'merged',
    localRevision: local.plot.revision,
    packageRevision: remote.plot.revision,
    addedTrees: [],
    updatedTrees: [],
    conflictTrees: [],
    addedRegens: [],
    updatedRegens: [],
    conflictRegens: [],
    notes: [],
    affected: [],
  };

  // 旧包判定：包内修订号 < 本机修订号 → 立即失效
  if (remote.plot.revision < local.plot.revision) {
    report.status = 'stale';
    report.affected.push({ kind: 'plot', id: local.plot.id, desc: `样地 ${local.plot.plotNo}（本机修订号 v${local.plot.revision}，包内仅 v${remote.plot.revision}）` });
    const lt = keyed(local.trees, treeKey);
    const rt = keyed(remote.trees, treeKey);
    const lr = keyed(local.regens, regenKey);
    const rr = keyed(remote.regens, regenKey);
    const treeKeys = new Set([...lt.keys(), ...rt.keys()]);
    treeKeys.forEach((k) => {
      const l = lt.get(k);
      const r = rt.get(k);
      if (l && r && !treeDataEqual(l, r)) {
        report.affected.push({ kind: 'tree', id: l.id, desc: `树号 ${l.treeNo}（第${l.round}期）两边不一致` });
      } else if (r && !l) {
        report.affected.push({ kind: 'tree', id: r.id, desc: `树号 ${r.treeNo}（第${r.round}期）仅包内有` });
      } else if (l && !r) {
        report.affected.push({ kind: 'tree', id: l.id, desc: `树号 ${l.treeNo}（第${l.round}期）仅本机有` });
      }
    });
    const regenKeys = new Set([...lr.keys(), ...rr.keys()]);
    regenKeys.forEach((k) => {
      const l = lr.get(k);
      const r = rr.get(k);
      if (l && r && !regenDataEqual(l, r)) {
        report.affected.push({ kind: 'regen', id: l.id, desc: `${l.layer} ${l.species}（第${l.round}期）两边不一致` });
      } else if (r && !l) {
        report.affected.push({ kind: 'regen', id: r.id, desc: `${r.layer} ${r.species}（第${r.round}期）仅包内有` });
      } else if (l && !r) {
        report.affected.push({ kind: 'regen', id: l.id, desc: `${l.layer} ${l.species}（第${l.round}期）仅本机有` });
      }
    });
    return {
      localPlotId: local.plot.id,
      plotNo: local.plot.plotNo,
      isNew: false,
      nextPlot: local.plot,
      nextTrees: local.trees,
      nextRegens: local.regens,
      report,
    };
  }

  // 三方合并：base 为导出方同步基线
  const baseTreeMap = keyed(remote.base.trees, treeKey);
  const localTreeMap = keyed(local.trees, treeKey);
  const remoteTreeMap = keyed(remote.trees, treeKey);
  const treeKeys = Array.from(new Set([...baseTreeMap.keys(), ...localTreeMap.keys(), ...remoteTreeMap.keys()]));

  const nextTrees: TreeRecord[] = [];
  for (const key of treeKeys) {
    const B = baseTreeMap.get(key);
    const L = localTreeMap.get(key);
    const R = remoteTreeMap.get(key);
    if (L && R) {
      if (treeDataEqual(L, R)) {
        nextTrees.push(L);
        continue;
      }
      const localChanged = B ? !treeDataEqual(L, B) : true;
      const remoteChanged = B ? !treeDataEqual(R, B) : true;
      if (localChanged && remoteChanged) {
        // 两边都有新测量值 → 保留本机，列入待核冲突
        nextTrees.push(L);
        report.conflictTrees.push({
          key,
          round: L.round,
          treeNo: L.treeNo,
          species: L.species,
          local: L,
          remote: R,
          fieldDiffs: diffFields(L, R, TREE_COMPARE_FIELDS),
        });
      } else if (remoteChanged) {
        // 仅远端改过 → 并入远端（保留本机 id）
        nextTrees.push({ ...R, id: L.id, plotId: local.plot.id });
        report.updatedTrees.push({
          key,
          round: R.round,
          treeNo: R.treeNo,
          species: R.species,
          changes: describeTreeChange(B, R),
        });
      } else {
        // 仅本机改过 → 保留本机
        nextTrees.push(L);
      }
    } else if (R && !L) {
      if (B && treeDataEqual(R, B)) {
        // 本机已删除、远端未改动 → 维持删除
        report.notes.push(`树号 ${R.treeNo}（第${R.round}期）：本机已删除且远端未改动，维持删除`);
      } else {
        // 远端新增（或远端改过而本机已删）→ 并入
        nextTrees.push({ ...R, plotId: local.plot.id });
        report.addedTrees.push({ key, round: R.round, treeNo: R.treeNo, species: R.species, changes: [] });
      }
    } else if (L && !R) {
      if (B && treeDataEqual(L, B)) {
        // 远端删除、本机未改 → 不删除，保留本机
        nextTrees.push(L);
        report.notes.push(`树号 ${L.treeNo}（第${L.round}期）：远端已删除，本机保留`);
      } else {
        // 远端删除但本机有改动 → 保留本机
        nextTrees.push(L);
        report.notes.push(`树号 ${L.treeNo}（第${L.round}期）：远端删除但本机有改动，保留本机`);
      }
    }
  }

  const baseRegenMap = keyed(remote.base.regens, regenKey);
  const localRegenMap = keyed(local.regens, regenKey);
  const remoteRegenMap = keyed(remote.regens, regenKey);
  const regenKeys = Array.from(new Set([...baseRegenMap.keys(), ...localRegenMap.keys(), ...remoteRegenMap.keys()]));

  const nextRegens: RegenShrub[] = [];
  for (const key of regenKeys) {
    const B = baseRegenMap.get(key);
    const L = localRegenMap.get(key);
    const R = remoteRegenMap.get(key);
    if (L && R) {
      if (regenDataEqual(L, R)) {
        nextRegens.push(L);
        continue;
      }
      const localChanged = B ? !regenDataEqual(L, B) : true;
      const remoteChanged = B ? !regenDataEqual(R, B) : true;
      if (localChanged && remoteChanged) {
        nextRegens.push(L);
        report.conflictRegens.push({
          key,
          layer: L.layer,
          species: L.species,
          round: L.round,
          local: L,
          remote: R,
          fieldDiffs: diffFields(L, R, REGEN_COMPARE_FIELDS),
        });
      } else if (remoteChanged) {
        nextRegens.push({ ...R, id: L.id, plotId: local.plot.id });
        report.updatedRegens.push({ key, layer: R.layer, species: R.species, round: R.round });
      } else {
        nextRegens.push(L);
      }
    } else if (R && !L) {
      if (B && regenDataEqual(R, B)) {
        report.notes.push(`${R.layer} ${R.species}（第${R.round}期）：本机已删除且远端未改动，维持删除`);
      } else {
        nextRegens.push({ ...R, plotId: local.plot.id });
        report.addedRegens.push({ key, layer: R.layer, species: R.species, round: R.round });
      }
    } else if (L && !R) {
      nextRegens.push(L);
      report.notes.push(`${L.layer} ${L.species}（第${L.round}期）：远端无此记录，本机保留`);
    }
  }

  // 样地修订号更新：取两边较大值 +1，使本次导入的旧包立即失效
  const nextRevision = Math.max(local.plot.revision, remote.plot.revision) + 1;
  const nextPlot: Plot = { ...local.plot, revision: nextRevision };

  return {
    localPlotId: local.plot.id,
    plotNo: local.plot.plotNo,
    isNew: false,
    nextPlot,
    nextTrees,
    nextRegens,
    report,
  };
}

/** 规划合并：对包内每个样地生成本机合并方案（不写库） */
export function planMerge(
  pkg: ExchangePackage,
  localPlots: Plot[],
  localTrees: TreeRecord[],
  localRegens: RegenShrub[],
): MergedPlot[] {
  return pkg.plots.map((ep) => {
    const localPlot = localPlots.find((p) => p.plotNo === ep.plot.plotNo);
    if (!localPlot) {
      // 新样地：随包整体导入
      const report: PlotMergeReport = {
        plotId: ep.plot.id,
        plotNo: ep.plot.plotNo,
        status: 'merged',
        localRevision: 0,
        packageRevision: ep.plot.revision,
        addedTrees: ep.trees.map((t) => ({ key: treeKey(t), round: t.round, treeNo: t.treeNo, species: t.species, changes: [] })),
        updatedTrees: [],
        conflictTrees: [],
        addedRegens: ep.regens.map((r) => ({ key: regenKey(r), layer: r.layer, species: r.species, round: r.round })),
        updatedRegens: [],
        conflictRegens: [],
        notes: ['新样地：随包整体导入'],
        affected: [],
      };
      return {
        localPlotId: ep.plot.id,
        plotNo: ep.plot.plotNo,
        isNew: true,
        nextPlot: { ...ep.plot, revision: ep.plot.revision + 1 },
        nextTrees: ep.trees,
        nextRegens: ep.regens,
        report,
      };
    }
    const local = {
      plot: localPlot,
      trees: localTrees.filter((t) => t.plotId === localPlot.id),
      regens: localRegens.filter((r) => r.plotId === localPlot.id),
    };
    return mergeExistingPlot(local, ep);
  });
}

/**
 * 执行合并：事务内替换样地数据、写同步基线、清旧比对结果。
 * 任一步失败则整体回滚，恢复原记录。
 */
export async function applyMerge(plans: MergedPlot[]): Promise<void> {
  await db.transaction('rw', db.plots, db.trees, db.regens, db.syncbases, db.rechecks, async () => {
    for (const plan of plans) {
      if (plan.report.status === 'stale') continue;
      await db.plots.put(plan.nextPlot);
      await db.trees.where('plotId').equals(plan.localPlotId).delete();
      await db.regens.where('plotId').equals(plan.localPlotId).delete();
      await db.trees.bulkPut(plan.nextTrees);
      await db.regens.bulkPut(plan.nextRegens);
      await setSyncBase({
        plotId: plan.localPlotId,
        revision: plan.nextPlot.revision,
        trees: plan.nextTrees,
        regens: plan.nextRegens,
        syncedAt: Date.now(),
      });
      // 清掉过期复查比对，稍后按新数据重算
      await db.rechecks.where('plotId').equals(plan.localPlotId).delete();
    }
  });
}

/** 合并后重算受影响样地的复查比对（林分汇总由 hooks 实时重算） */
export async function recalcAfterMerge(plans: MergedPlot[]): Promise<void> {
  for (const plan of plans) {
    if (plan.report.status === 'stale') continue;
    try {
      await recalcRecheckDiffs(plan.localPlotId);
    } catch {
      /* 重算失败不影响已合并数据，提示用户手动重算 */
    }
  }
}
