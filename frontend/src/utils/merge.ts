import {
  db,
  regenBizKey,
  replaceRecheckDiffs,
  treeBizKey,
} from './db';
import { newId } from './id';
import { buildRecheckDiffs, latestRoundPair } from './recheck';
import {
  avgDbh,
  avgHeight,
  basalAreaPerHectare,
  perHectareCount,
  regenDensity,
} from './forestCalc';
import type { Plot } from '../types/plot';
import type { TreeRecord } from '../types/tree';
import type { RegenShrub } from '../types/regen';
import type { RecheckDiff } from '../types/recheck';
import {
  EXCHANGE_FORMAT,
  EXCHANGE_FORMAT_VERSION,
  MergeFailedError,
  StalePackageError,
  type AffectedObject,
  type ExchangePackage,
  type MergeConflict,
  type MergeLog,
  type MergePreview,
  type MergeReport,
} from '../types/sync';

/** 样木参与比对/合并的业务字段（不含 id、rev、时间戳） */
const TREE_FIELDS = [
  'treeNo',
  'species',
  'dbhCm',
  'heightM',
  'underBranchH',
  'crownWidth',
  'status',
  'origin',
  'healthClass',
  'tiltDeg',
  'remark',
  'round',
] as const;

/** 更新苗参与比对/合并的业务字段 */
const REGEN_FIELDS = [
  'layer',
  'species',
  'heightCm',
  'count',
  'ageGroup',
  'distribution',
  'browseDamage',
  'round',
] as const;

/** 样地描述字段：与本机不一致时登记待核冲突，不自动覆盖 */
const PLOT_FIELDS = [
  'plotNo',
  'locality',
  'lng',
  'lat',
  'shape',
  'area',
  'elevation',
  'slope',
  'aspect',
  'forestType',
  'canopyDensity',
  'dominantSpecies',
  'crew',
] as const;

function pick(obj: object, fields: readonly string[]): Record<string, string | number | undefined> {
  const out: Record<string, string | number | undefined> = {};
  const anyObj = obj as Record<string, unknown>;
  fields.forEach((f) => {
    const v = anyObj[f];
    // 只收集实际存在的值，避免 undefined 在展开时覆盖本机字段
    if (typeof v === 'string' || typeof v === 'number') out[f] = v;
  });
  return out;
}

function sameFields(a: object, b: object, fields: readonly string[]): boolean {
  const anyA = a as Record<string, unknown>;
  const anyB = b as Record<string, unknown>;
  return fields.every((f) => anyA[f] === anyB[f]);
}

// ---------------------------------------------------------------------------
// 交换包导出 / 校验
// ---------------------------------------------------------------------------

/** 导出交换包：写明样地修订号与期次；导出即记为本机一个同步点 */
export async function exportPlotPackage(plotId: string, device: string): Promise<ExchangePackage> {
  const plot = await db.plots.get(plotId);
  if (!plot) throw new Error('未找到要导出的样地');
  const trees = await db.trees.where('plotId').equals(plotId).toArray();
  const regens = await db.regens.where('plotId').equals(plotId).toArray();
  const pkg: ExchangePackage = {
    format: EXCHANGE_FORMAT,
    formatVersion: EXCHANGE_FORMAT_VERSION,
    packageId: newId('pkg'),
    plotId: plot.id,
    plotNo: plot.plotNo,
    plotRevision: plot.revision,
    baseRevision: plot.syncedRevision,
    round: plot.surveyRound,
    device,
    exportedAt: Date.now(),
    plot,
    trees,
    regens,
  };
  await db.plots.update(plotId, { syncedRevision: plot.revision });
  return pkg;
}

/**
 * 校验并规范化交换包；缺少 rev/updatedAt 的旧包按新结构升级（补齐默认值）。
 * 结构不合法时抛出 Error。
 */
export function normalizePackage(raw: unknown): ExchangePackage {
  if (!raw || typeof raw !== 'object') throw new Error('交换包不是有效的 JSON 对象');
  const pkg = raw as Partial<ExchangePackage>;
  if (pkg.format !== EXCHANGE_FORMAT) throw new Error('不是本系统的交换包（format 不匹配）');
  const formatVersion = typeof pkg.formatVersion === 'number' ? pkg.formatVersion : 0;
  if (formatVersion > EXCHANGE_FORMAT_VERSION) {
    throw new Error(`交换包格式版本过新（v${formatVersion}），请升级本机应用`);
  }
  if (typeof pkg.plotId !== 'string' || !pkg.plotId) throw new Error('交换包缺少 plotId');
  if (typeof pkg.plotNo !== 'string' || !pkg.plotNo) throw new Error('交换包缺少样地号');
  if (!pkg.plot || typeof pkg.plot !== 'object') throw new Error('交换包缺少样地本体');
  if (!Array.isArray(pkg.trees) || !Array.isArray(pkg.regens)) {
    throw new Error('交换包缺少样木或更新苗记录');
  }

  // 旧结构升级：补齐修订号、期次与时间戳字段
  const plotRevision =
    typeof pkg.plotRevision === 'number' && pkg.plotRevision >= 1 ? pkg.plotRevision : 1;
  const baseRevision = typeof pkg.baseRevision === 'number' ? pkg.baseRevision : 0;
  const exportedAt = typeof pkg.exportedAt === 'number' ? pkg.exportedAt : Date.now();
  const plot: Plot = {
    ...pkg.plot,
    id: typeof pkg.plot.id === 'string' && pkg.plot.id ? pkg.plot.id : pkg.plotId,
    plotNo: pkg.plotNo,
    surveyRound:
      typeof pkg.plot.surveyRound === 'number' && pkg.plot.surveyRound >= 1
        ? pkg.plot.surveyRound
        : typeof pkg.round === 'number' && pkg.round >= 1
          ? pkg.round
          : 1,
    revision: plotRevision,
    syncedRevision: baseRevision,
    updatedAt: typeof pkg.plot.updatedAt === 'number' ? pkg.plot.updatedAt : exportedAt,
    createdAt: typeof pkg.plot.createdAt === 'number' ? pkg.plot.createdAt : exportedAt,
  };
  const round = typeof pkg.round === 'number' && pkg.round >= 1 ? pkg.round : plot.surveyRound;
  const trees = pkg.trees.map((t) => ({
    ...t,
    plotId: pkg.plotId as string,
    rev: typeof t.rev === 'number' ? t.rev : plotRevision,
    updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : t.measuredAt ?? exportedAt,
  }));
  const regens = pkg.regens.map((r) => ({
    ...r,
    plotId: pkg.plotId as string,
    rev: typeof r.rev === 'number' ? r.rev : plotRevision,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : exportedAt,
  }));

  return {
    format: EXCHANGE_FORMAT,
    formatVersion: EXCHANGE_FORMAT_VERSION,
    packageId: typeof pkg.packageId === 'string' ? pkg.packageId : newId('pkg'),
    plotId: pkg.plotId,
    plotNo: pkg.plotNo,
    plotRevision,
    baseRevision,
    round,
    device: typeof pkg.device === 'string' && pkg.device ? pkg.device : '未知设备',
    exportedAt,
    plot,
    trees,
    regens,
  };
}

// ---------------------------------------------------------------------------
// 合并计划（预演与正式合并共用）
// ---------------------------------------------------------------------------

type Action = 'insert' | 'update' | 'skip' | 'tombstone' | 'conflict';

interface TreeDecision {
  action: Action;
  remote: TreeRecord;
  local?: TreeRecord;
}

interface RegenDecision {
  action: Action;
  remote: RegenShrub;
  local?: RegenShrub;
}

interface MergePlan {
  localPlot: Plot | null;
  /** 目标样地 id（本机侧；新样地导入时为包内 id） */
  plotId: string;
  isNewPlot: boolean;
  treeDecisions: TreeDecision[];
  regenDecisions: RegenDecision[];
  conflicts: MergeConflict[];
  mergedRound: number;
}

interface DecideInput {
  hasLocal: boolean;
  tombstoned: boolean;
  /** 对方记录相对其基准修订号是否有改动 */
  remoteChanged: boolean;
  /** 本机记录在上次同步点之后是否被改过 */
  localDirty: boolean;
  identical: boolean;
}

function decideAction(input: DecideInput): Action {
  if (!input.hasLocal) {
    // 本机已删且对方自基准期未再改 → 不复活；否则按单边新增并入
    return input.tombstoned && !input.remoteChanged ? 'tombstone' : 'insert';
  }
  if (input.identical) return 'skip';
  if (!input.remoteChanged) return 'skip'; // 对方没有新东西，保留本机
  if (!input.localDirty) return 'update'; // 单边修改，直接并入
  return 'conflict'; // 两边都改过：保留本机值，登记待核
}

async function planMerge(pkg: ExchangePackage): Promise<MergePlan> {
  // 样地匹配：先按 id，再按样地号（另一台机器独立建档的情形）
  let localPlot = await db.plots.get(pkg.plotId);
  if (!localPlot) {
    localPlot = await db.plots.where('plotNo').equals(pkg.plotNo).first();
  }

  if (localPlot) {
    // 本机修订号已更新 → 旧交换包立即失效
    if (pkg.plotRevision < localPlot.revision) {
      const affected = await listAffectedObjects(pkg, localPlot);
      throw new StalePackageError(
        `交换包已失效：包内修订号 r${pkg.plotRevision} 低于本机当前 r${localPlot.revision}（本机数据已更新）`,
        affected,
      );
    }
    const done = await db.merges.get(pkg.packageId);
    if (done && done.status === '成功') {
      throw new StalePackageError(`交换包 ${pkg.packageId} 已成功导入过，不能重复合并`, []);
    }
  }

  const plotId = localPlot ? localPlot.id : pkg.plotId;
  const localTrees = localPlot ? await db.trees.where('plotId').equals(plotId).toArray() : [];
  const localRegens = localPlot ? await db.regens.where('plotId').equals(plotId).toArray() : [];
  const deletions = localPlot ? await db.deletions.where('plotId').equals(plotId).toArray() : [];
  const tombstones = new Set(deletions.map((d) => d.key));
  const syncedRev = localPlot?.syncedRevision ?? 0;

  const localTreeByKey = new Map(localTrees.map((t) => [treeBizKey(t.treeNo, t.round), t]));
  const localTreeIds = new Set(localTrees.map((t) => t.id));
  const conflicts: MergeConflict[] = [];

  const treeDecisions: TreeDecision[] = pkg.trees.map((remote) => {
    const key = treeBizKey(remote.treeNo, remote.round);
    const local = localTreeByKey.get(key);
    const action = decideAction({
      hasLocal: local !== undefined,
      tombstoned: tombstones.has(key),
      remoteChanged: remote.rev > pkg.baseRevision,
      localDirty: local !== undefined && local.rev > syncedRev,
      identical: local !== undefined && sameFields(local, remote, TREE_FIELDS),
    });
    if (action === 'conflict' && local) {
      conflicts.push({
        id: newId('conf'),
        plotId,
        kind: '样木',
        treeNo: remote.treeNo,
        round: remote.round,
        species: remote.species,
        localValues: pick(local, TREE_FIELDS),
        remoteValues: pick(remote, TREE_FIELDS),
        packageId: pkg.packageId,
        device: pkg.device,
        at: Date.now(),
        status: '待核',
      });
    }
    // id 撞车（两边各自生成）：并入时换新 id
    if (action === 'insert' && localTreeIds.has(remote.id)) {
      return { action, remote: { ...remote, id: newId('tree') }, local };
    }
    return { action, remote, local };
  });

  const localRegenByKey = new Map(localRegens.map((r) => [regenBizKey(r.layer, r.species, r.round), r]));
  const localRegenIds = new Set(localRegens.map((r) => r.id));
  const regenDecisions: RegenDecision[] = pkg.regens.map((remote) => {
    const key = regenBizKey(remote.layer, remote.species, remote.round);
    const local = localRegenByKey.get(key);
    const action = decideAction({
      hasLocal: local !== undefined,
      tombstoned: tombstones.has(key),
      remoteChanged: remote.rev > pkg.baseRevision,
      localDirty: local !== undefined && local.rev > syncedRev,
      identical: local !== undefined && sameFields(local, remote, REGEN_FIELDS),
    });
    if (action === 'conflict' && local) {
      conflicts.push({
        id: newId('conf'),
        plotId,
        kind: '更新苗',
        treeNo: `${remote.layer}/${remote.species}`,
        round: remote.round,
        species: remote.species,
        localValues: pick(local, REGEN_FIELDS),
        remoteValues: pick(remote, REGEN_FIELDS),
        packageId: pkg.packageId,
        device: pkg.device,
        at: Date.now(),
        status: '待核',
      });
    }
    if (action === 'insert' && localRegenIds.has(remote.id)) {
      return { action, remote: { ...remote, id: newId('regen') }, local };
    }
    return { action, remote, local };
  });

  // 样地描述字段：以本机为准，不一致登记一条待核冲突
  if (localPlot && !sameFields(localPlot, pkg.plot, PLOT_FIELDS)) {
    conflicts.push({
      id: newId('conf'),
      plotId,
      kind: '样地',
      treeNo: '—',
      round: 0,
      species: '',
      localValues: pick(localPlot, PLOT_FIELDS),
      remoteValues: pick(pkg.plot, PLOT_FIELDS),
      packageId: pkg.packageId,
      device: pkg.device,
      at: Date.now(),
      status: '待核',
    });
  }

  const mergedRound = Math.max(localPlot?.surveyRound ?? 1, pkg.round, pkg.plot.surveyRound ?? 1);
  return {
    localPlot: localPlot ?? null,
    plotId,
    isNewPlot: !localPlot,
    treeDecisions,
    regenDecisions,
    conflicts,
    mergedRound,
  };
}

function countActions(plan: MergePlan): Pick<MergePreview, 'added' | 'updated' | 'skipped' | 'tombstoned'> {
  const all = [...plan.treeDecisions, ...plan.regenDecisions];
  return {
    added: all.filter((d) => d.action === 'insert').length,
    updated: all.filter((d) => d.action === 'update').length,
    skipped: all.filter((d) => d.action === 'skip').length,
    tombstoned: all.filter((d) => d.action === 'tombstone').length,
  };
}

/** 合并预演：返回各项数量与冲突数，不落库 */
export async function previewMerge(pkg: ExchangePackage): Promise<MergePreview> {
  const plan = await planMerge(pkg);
  const counts = countActions(plan);
  return {
    plotId: plan.plotId,
    plotNo: plan.localPlot?.plotNo ?? pkg.plotNo,
    isNewPlot: plan.isNewPlot,
    ...counts,
    conflictCount: plan.conflicts.length,
  };
}

// ---------------------------------------------------------------------------
// 旧交换包失效：列出受影响对象
// ---------------------------------------------------------------------------

async function listAffectedObjects(pkg: ExchangePackage, localPlot: Plot): Promise<AffectedObject[]> {
  const out: AffectedObject[] = [];
  if (!sameFields(localPlot, pkg.plot, PLOT_FIELDS)) {
    const diffs = PLOT_FIELDS.filter(
      (f) => (localPlot as unknown as Record<string, unknown>)[f] !== (pkg.plot as unknown as Record<string, unknown>)[f],
    );
    out.push({ kind: '样地', key: pkg.plotNo, detail: `字段不一致：${diffs.join('、')}` });
  }
  const localTrees = await db.trees.where('plotId').equals(localPlot.id).toArray();
  const treeMap = new Map(localTrees.map((t) => [treeBizKey(t.treeNo, t.round), t]));
  pkg.trees.forEach((remote) => {
    const local = treeMap.get(treeBizKey(remote.treeNo, remote.round));
    if (!local) {
      out.push({ kind: '样木', key: `树号 ${remote.treeNo}（第 ${remote.round} 期）`, detail: '本机缺少该记录' });
    } else if (!sameFields(local, remote, TREE_FIELDS)) {
      out.push({
        kind: '样木',
        key: `树号 ${remote.treeNo}（第 ${remote.round} 期）`,
        detail: `胸径 本机 ${local.dbhCm} / 包内 ${remote.dbhCm} cm`,
      });
    }
  });
  const localRegens = await db.regens.where('plotId').equals(localPlot.id).toArray();
  const regenMap = new Map(localRegens.map((r) => [regenBizKey(r.layer, r.species, r.round), r]));
  pkg.regens.forEach((remote) => {
    const key = regenBizKey(remote.layer, remote.species, remote.round);
    const local = regenMap.get(key);
    if (!local) {
      out.push({
        kind: '更新苗',
        key: `${remote.layer}/${remote.species}（第 ${remote.round} 期）`,
        detail: '本机缺少该记录',
      });
    } else if (!sameFields(local, remote, REGEN_FIELDS)) {
      out.push({
        kind: '更新苗',
        key: `${remote.layer}/${remote.species}（第 ${remote.round} 期）`,
        detail: `株数 本机 ${local.count} / 包内 ${remote.count}`,
      });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// 正式合并（事务 + 失败恢复 + 合并后重算）
// ---------------------------------------------------------------------------

interface Snapshot {
  plot: Plot | undefined;
  trees: TreeRecord[];
  regens: RegenShrub[];
  rechecks: RecheckDiff[];
}

async function snapshotPlot(plotId: string): Promise<Snapshot> {
  const [plot, trees, regens, rechecks] = await Promise.all([
    db.plots.get(plotId),
    db.trees.where('plotId').equals(plotId).toArray(),
    db.regens.where('plotId').equals(plotId).toArray(),
    db.rechecks.where('plotId').equals(plotId).toArray(),
  ]);
  return { plot, trees, regens, rechecks };
}

async function restorePlot(plotId: string, snap: Snapshot): Promise<void> {
  await db.transaction('rw', [db.plots, db.trees, db.regens, db.rechecks], async () => {
    await db.trees.where('plotId').equals(plotId).delete();
    await db.regens.where('plotId').equals(plotId).delete();
    await db.rechecks.where('plotId').equals(plotId).delete();
    if (snap.plot) await db.plots.put(snap.plot);
    if (snap.trees.length > 0) await db.trees.bulkPut(snap.trees);
    if (snap.regens.length > 0) await db.regens.bulkPut(snap.regens);
    if (snap.rechecks.length > 0) await db.rechecks.bulkPut(snap.rechecks);
  });
}

async function writeMergeLog(log: MergeLog): Promise<void> {
  await db.merges.put(log);
}

/**
 * 执行离线合并。
 * - 单边新增/修改直接并入；两边都改过保留本机值并列待核冲突；
 * - 任一环节失败即回滚并恢复快照，抛 MergeFailedError；
 * - 成功后样地修订号更新，旧交换包随之失效；
 * - 复查比对与林分汇总按合并后数据重算。
 */
export async function applyMerge(pkg: ExchangePackage): Promise<MergeReport> {
  // 先做一次只读计划：陈旧包在此抛出 StalePackageError（不写日志以外的任何数据）
  const probe = await planMerge(pkg);
  const plotId = probe.plotId;
  const fromRevision = probe.localPlot?.revision ?? 0;
  const snapshot = await snapshotPlot(plotId);
  const now = Date.now();

  try {
    const result = await db.transaction(
      'rw',
      [db.plots, db.trees, db.regens, db.rechecks, db.conflicts, db.deletions, db.merges],
      async () => {
        // 事务内重新计划，保证判定与写入基于同一快照
        const plan = await planMerge(pkg);
        const newRevision = probe.isNewPlot
          ? pkg.plotRevision
          : Math.max(plan.localPlot?.revision ?? 0, pkg.plotRevision) + 1;

        const treePuts: TreeRecord[] = [];
        const regenPuts: RegenShrub[] = [];
        const clearedKeys: string[] = [];

        plan.treeDecisions.forEach((d) => {
          if (d.action === 'insert') {
            treePuts.push({ ...d.remote, plotId, rev: newRevision, updatedAt: now });
            clearedKeys.push(treeBizKey(d.remote.treeNo, d.remote.round));
          } else if (d.action === 'update' && d.local) {
            treePuts.push({ ...d.remote, id: d.local.id, plotId, rev: newRevision, updatedAt: now });
            clearedKeys.push(treeBizKey(d.remote.treeNo, d.remote.round));
          }
        });
        plan.regenDecisions.forEach((d) => {
          if (d.action === 'insert') {
            regenPuts.push({ ...d.remote, plotId, rev: newRevision, updatedAt: now });
            clearedKeys.push(regenBizKey(d.remote.layer, d.remote.species, d.remote.round));
          } else if (d.action === 'update' && d.local) {
            regenPuts.push({ ...d.remote, id: d.local.id, plotId, rev: newRevision, updatedAt: now });
            clearedKeys.push(regenBizKey(d.remote.layer, d.remote.species, d.remote.round));
          }
        });

        if (treePuts.length > 0) await db.trees.bulkPut(treePuts);
        if (regenPuts.length > 0) await db.regens.bulkPut(regenPuts);
        if (clearedKeys.length > 0) {
          await db.deletions.bulkDelete(clearedKeys.map((k) => `${plotId}:${k}`));
        }
        if (plan.conflicts.length > 0) await db.conflicts.bulkPut(plan.conflicts);

        // 样地：修订号更新（旧交换包随之失效），期次取两边最大
        if (plan.isNewPlot) {
          await db.plots.put({
            ...pkg.plot,
            id: plotId,
            surveyRound: plan.mergedRound,
            revision: newRevision,
            syncedRevision: newRevision,
            updatedAt: now,
            createdAt: pkg.plot.createdAt ?? now,
          });
        } else {
          await db.plots.update(plotId, {
            revision: newRevision,
            syncedRevision: newRevision,
            surveyRound: plan.mergedRound,
            updatedAt: now,
          });
        }

        // 合并后重算：复查比对（最新两期）整批重写
        const mergedTrees = await db.trees.where('plotId').equals(plotId).toArray();
        const pair = latestRoundPair(mergedTrees, plotId);
        let recheckRegenerated = false;
        if (pair) {
          const diffs = buildRecheckDiffs(mergedTrees, plotId, pair[0], pair[1]);
          await replaceRecheckDiffs(plotId, diffs);
          recheckRegenerated = true;
        } else {
          await replaceRecheckDiffs(plotId, []);
        }

        const applied = countActions(plan);
        await db.merges.put({
          id: pkg.packageId,
          plotId,
          plotNo: plan.localPlot?.plotNo ?? pkg.plotNo,
          packageId: pkg.packageId,
          device: pkg.device,
          at: now,
          added: applied.added,
          updated: applied.updated,
          skipped: applied.skipped,
          tombstoned: applied.tombstoned,
          conflictCount: plan.conflicts.length,
          fromRevision,
          toRevision: newRevision,
          status: '成功',
          message: `合并自「${pkg.device}」，修订号 r${fromRevision || '-'} → r${newRevision}`,
        });

        return { newRevision, recheckRegenerated, conflicts: plan.conflicts, applied };
      },
    );

    // 林分汇总重算（基于合并后的库内数据）
    const plot = await db.plots.get(plotId);
    const trees = await db.trees.where('plotId').equals(plotId).toArray();
    const regens = await db.regens.where('plotId').equals(plotId).toArray();
    const roundTrees = trees.filter((t) => t.round === (plot?.surveyRound ?? 1));
    const roundRegens = regens.filter((r) => r.round === (plot?.surveyRound ?? 1));
    const area = plot?.area ?? 0;
    const alive = roundTrees.filter((t) => t.status === '活立木');

    return {
      plotId,
      plotNo: plot?.plotNo ?? pkg.plotNo,
      packageId: pkg.packageId,
      at: now,
      added: result.applied.added,
      updated: result.applied.updated,
      skipped: result.applied.skipped,
      tombstoned: result.applied.tombstoned,
      conflicts: result.conflicts,
      fromRevision,
      newRevision: result.newRevision,
      recheckRegenerated: result.recheckRegenerated,
      stand: {
        perHa: perHectareCount(alive.length, area),
        meanDbh: avgDbh(roundTrees),
        meanHeight: avgHeight(roundTrees),
        basalAreaPerHa: basalAreaPerHectare(roundTrees, area),
        regenPerHa: plot ? regenDensity(roundRegens, plot, '更新苗') : 0,
        shrubPerHa: plot ? regenDensity(roundRegens, plot, '灌木') : 0,
      },
    };
  } catch (err) {
    if (err instanceof StalePackageError) throw err;
    // 合并失败：恢复原记录
    await restorePlot(plotId, snapshot);
    await writeMergeLog({
      id: newId('merge'),
      plotId,
      plotNo: snapshot.plot?.plotNo ?? pkg.plotNo,
      packageId: pkg.packageId,
      device: pkg.device,
      at: Date.now(),
      added: 0,
      updated: 0,
      skipped: 0,
      tombstoned: 0,
      conflictCount: 0,
      fromRevision,
      toRevision: fromRevision,
      status: '失败已恢复',
      message: err instanceof Error ? err.message : String(err),
    });
    throw new MergeFailedError(
      `合并失败，已恢复原记录。原因：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** 记录一次被拒绝的导入（旧交换包失效），便于审计 */
export async function logRejectedPackage(pkg: ExchangePackage, reason: string): Promise<void> {
  const localPlot = (await db.plots.get(pkg.plotId)) ?? (await db.plots.where('plotNo').equals(pkg.plotNo).first());
  await writeMergeLog({
    id: newId('merge'),
    plotId: localPlot?.id ?? pkg.plotId,
    plotNo: localPlot?.plotNo ?? pkg.plotNo,
    packageId: pkg.packageId,
    device: pkg.device,
    at: Date.now(),
    added: 0,
    updated: 0,
    skipped: 0,
    tombstoned: 0,
    conflictCount: 0,
    fromRevision: localPlot?.revision ?? 0,
    toRevision: localPlot?.revision ?? 0,
    status: '已拒绝',
    message: reason,
  });
}

// ---------------------------------------------------------------------------
// 待核冲突处理
// ---------------------------------------------------------------------------

export async function listConflicts(status?: MergeConflict['status']): Promise<MergeConflict[]> {
  const rows = status
    ? await db.conflicts.where('status').equals(status).toArray()
    : await db.conflicts.toArray();
  return rows.sort((a, b) => b.at - a.at);
}

export async function listMergeLogs(): Promise<MergeLog[]> {
  const rows = await db.merges.toArray();
  return rows.sort((a, b) => b.at - a.at);
}

/** 处理待核冲突：采用对方值（本机修订号 +1）或保持本机值 */
export async function resolveConflict(conflictId: string, choice: 'remote' | 'local'): Promise<void> {
  const conflict = await db.conflicts.get(conflictId);
  if (!conflict || conflict.status !== '待核') return;

  if (choice === 'remote') {
    const plot = await db.plots.get(conflict.plotId);
    const newRevision = (plot?.revision ?? 1) + 1;
    const now = Date.now();
    if (conflict.kind === '样木') {
      const local = await db.trees
        .where('plotId')
        .equals(conflict.plotId)
        .toArray()
        .then((rows) => rows.find((t) => t.treeNo === conflict.treeNo && t.round === conflict.round));
      if (local) {
        const patch = pick(conflict.remoteValues, TREE_FIELDS);
        await db.trees.put({ ...local, ...patch, rev: newRevision, updatedAt: now } as TreeRecord);
      }
    } else if (conflict.kind === '更新苗') {
      const [layer, species] = conflict.treeNo.split('/');
      const local = await db.regens
        .where('plotId')
        .equals(conflict.plotId)
        .toArray()
        .then((rows) =>
          rows.find((r) => r.layer === layer && r.species === species && r.round === conflict.round),
        );
      if (local) {
        const patch = pick(conflict.remoteValues, REGEN_FIELDS);
        await db.regens.put({ ...local, ...patch, rev: newRevision, updatedAt: now } as RegenShrub);
      }
    } else {
      const patch = pick(conflict.remoteValues, PLOT_FIELDS);
      await db.plots.update(conflict.plotId, patch);
    }
    await db.plots.update(conflict.plotId, { revision: newRevision, updatedAt: now });
    await db.conflicts.update(conflictId, { status: '已采用对方' });
  } else {
    await db.conflicts.update(conflictId, { status: '已保持本机' });
  }
}
