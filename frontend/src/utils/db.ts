import Dexie, { type Table } from 'dexie';
import type { Plot } from '../types/plot';
import type { TreeRecord } from '../types/tree';
import type { RegenShrub } from '../types/regen';
import type { RecheckDiff } from '../types/recheck';
import type { DeletionRecord, MergeConflict, MergeLog } from '../types/sync';
import { newId } from './id';

export const DB_NAME = 'gbforestplot';
export const DB_VERSION = 3;
export const LS_VERSION_KEY = 'gbforestplot:db-version';

class ForestPlotDB extends Dexie {
  plots!: Table<Plot, string>;
  trees!: Table<TreeRecord, string>;
  regens!: Table<RegenShrub, string>;
  rechecks!: Table<RecheckDiff, string>;
  merges!: Table<MergeLog, string>;
  conflicts!: Table<MergeConflict, string>;
  deletions!: Table<DeletionRecord, string>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      plots: 'id, plotNo, locality, forestType, surveyRound, createdAt',
      trees: 'id, plotId, treeNo, species, round, status',
      regens: 'id, plotId, layer, species, round',
      rechecks: 'id, plotId, baseRound, targetRound, treeNo',
    });
    this.version(2)
      .stores({
        plots: 'id, plotNo, locality, forestType, surveyRound, locked, createdAt',
        trees: 'id, plotId, treeNo, species, round, status, measuredAt',
        regens: 'id, plotId, layer, species, round, heightCm',
        rechecks: 'id, plotId, baseRound, targetRound, treeNo, generatedAt',
      })
      .upgrade(async (tx) => {
        await tx
          .table('plots')
          .toCollection()
          .modify((row: any) => {
            if (row.locked === undefined) row.locked = false;
            if (row.surveyRound === undefined) row.surveyRound = 1;
          });
        await tx
          .table('trees')
          .toCollection()
          .modify((row: any) => {
            if (row.round === undefined) row.round = 1;
            if (row.measuredAt === undefined) row.measuredAt = Date.now();
          });
      });
    // v3：离线合并。样地补修订号，记录补 rev/updatedAt，新增合并日志、待核冲突与删除墓碑三张表
    this.version(3)
      .stores({
        plots: 'id, plotNo, locality, forestType, surveyRound, locked, createdAt',
        trees: 'id, plotId, treeNo, species, round, status, measuredAt',
        regens: 'id, plotId, layer, species, round, heightCm',
        rechecks: 'id, plotId, baseRound, targetRound, treeNo, generatedAt',
        merges: 'id, plotId, at, status',
        conflicts: 'id, plotId, treeNo, round, at, status',
        deletions: 'id, plotId, key, at',
      })
      .upgrade(async (tx) => {
        const now = Date.now();
        await tx
          .table('plots')
          .toCollection()
          .modify((row: any) => {
            if (row.revision === undefined) row.revision = 1;
            if (row.syncedRevision === undefined) row.syncedRevision = 1;
            if (row.updatedAt === undefined) row.updatedAt = row.createdAt ?? now;
          });
        await tx
          .table('trees')
          .toCollection()
          .modify((row: any) => {
            if (row.rev === undefined) row.rev = 1;
            if (row.updatedAt === undefined) row.updatedAt = row.measuredAt ?? now;
          });
        await tx
          .table('regens')
          .toCollection()
          .modify((row: any) => {
            if (row.rev === undefined) row.rev = 1;
            if (row.updatedAt === undefined) row.updatedAt = now;
          });
      });
  }
}

export const db = new ForestPlotDB();

export function markDbVersion(): void {
  try {
    window.localStorage.setItem(LS_VERSION_KEY, String(DB_VERSION));
  } catch {
    /* localStorage 不可用时忽略 */
  }
}

export function readDbVersion(): number {
  try {
    const raw = window.localStorage.getItem(LS_VERSION_KEY);
    return raw ? Number(raw) : DB_VERSION;
  } catch {
    return DB_VERSION;
  }
}

/** 样木业务键：同样地内 树号+期次 唯一 */
export function treeBizKey(treeNo: string, round: number): string {
  return `tree:${treeNo}:${round}`;
}

/** 更新苗/灌木业务键：同样地内 层位+树种+期次 唯一 */
export function regenBizKey(layer: string, species: string, round: number): string {
  return `regen:${layer}:${species}:${round}`;
}

/** 本机改动前调用：样地修订号 +1，返回新修订号作为记录的 rev */
export async function bumpPlotRevision(plotId: string): Promise<number> {
  const plot = await db.plots.get(plotId);
  if (!plot) return 1;
  const next = (plot.revision ?? 1) + 1;
  await db.plots.update(plotId, { revision: next, updatedAt: Date.now() });
  return next;
}

/** 登记删除墓碑：合并时对方包里的旧记录不会把本机已删数据复活 */
export async function recordDeletion(plotId: string, key: string, rev: number): Promise<void> {
  await db.deletions.put({ id: `${plotId}:${key}`, plotId, key, rev, at: Date.now() });
}

/** 同业务键重新录入后清除墓碑 */
export async function clearDeletion(plotId: string, key: string): Promise<void> {
  await db.deletions.delete(`${plotId}:${key}`);
}

export async function saveRecheckDiffs(diffs: RecheckDiff[]): Promise<void> {
  await db.rechecks.bulkPut(diffs);
}

/** 合并后重算：整批替换该样地的复查比对存档 */
export async function replaceRecheckDiffs(plotId: string, diffs: RecheckDiff[]): Promise<void> {
  await db.rechecks.where('plotId').equals(plotId).delete();
  if (diffs.length > 0) await db.rechecks.bulkPut(diffs);
}

export async function loadRecheckDiffs(plotId: string): Promise<RecheckDiff[]> {
  const rows = await db.rechecks.where('plotId').equals(plotId).toArray();
  return rows.sort((a, b) => a.treeNo.localeCompare(b.treeNo));
}

/** 首次进入灌入示范样地与两期样木数据 */
export async function ensureSeedData(): Promise<void> {
  const count = await db.plots.count();
  if (count > 0) return;

  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const plotId = newId('plot');
  const plot2Id = newId('plot');

  const plots: Plot[] = [
    {
      id: plotId,
      plotNo: 'FP-4102',
      locality: '黑龙江凉水林场 12 林班',
      lng: 128.8934,
      lat: 47.1832,
      shape: '方形',
      area: 600,
      elevation: 412,
      slope: 8,
      aspect: '东南',
      forestType: '针阔混交林',
      canopyDensity: 0.72,
      dominantSpecies: '红松 + 紫椴',
      surveyRound: 2,
      surveyedAt: now - 6 * day,
      crew: '调查一组（顾青、李慕）',
      locked: true,
      revision: 1,
      syncedRevision: 1,
      updatedAt: now - 6 * day,
      createdAt: now - 400 * day,
    },
    {
      id: plot2Id,
      plotNo: 'FP-4115',
      locality: '黑龙江凉水林场 15 林班',
      lng: 128.9012,
      lat: 47.1901,
      shape: '圆形',
      area: 500,
      elevation: 388,
      slope: 14,
      aspect: '西南',
      forestType: '阔叶林',
      canopyDensity: 0.65,
      dominantSpecies: '蒙古栎',
      surveyRound: 1,
      surveyedAt: now - 3 * day,
      crew: '调查二组（周砚）',
      locked: false,
      revision: 1,
      syncedRevision: 1,
      updatedAt: now - 3 * day,
      createdAt: now - 120 * day,
    },
  ];

  type Seed = [string, string, number, number, number, number, TreeRecord['status']];
  const seeds: Seed[] = [
    ['1', '红松', 34.2, 18.6, 7.4, 5.2, '活立木'],
    ['2', '紫椴', 26.8, 15.2, 5.1, 4.4, '活立木'],
    ['3', '红松', 41.5, 21.3, 9.2, 6.1, '活立木'],
    ['4', '蒙古栎', 18.4, 11.5, 3.6, 3.2, '活立木'],
    ['5', '色木槭', 12.6, 9.4, 2.8, 2.6, '活立木'],
  ];

  const trees: TreeRecord[] = [];
  seeds.forEach(([treeNo, species, dbh, h, ubh, cw, status]) => {
    trees.push({
      id: newId('tree'),
      plotId,
      treeNo,
      species,
      dbhCm: dbh,
      heightM: h,
      underBranchH: ubh,
      crownWidth: cw,
      status,
      origin: '天然',
      healthClass: '健康',
      tiltDeg: 2,
      remark: `样地中部 ${treeNo} 号桩`,
      round: 1,
      measuredAt: now - 370 * day,
      rev: 1,
      updatedAt: now - 370 * day,
    });
  });
  // 第 2 期：树号 1/2/3/5 复测（胸径增大），树号 4 被采伐 → 复查比对可标记缺失
  seeds.forEach(([treeNo, species, dbh, h, ubh, cw], index) => {
    if (treeNo === '4') return;
    const growth = [1.8, 1.4, 2.2, 0.9][index > 3 ? 3 : index];
    trees.push({
      id: newId('tree'),
      plotId,
      treeNo,
      species,
      dbhCm: Math.round((dbh + growth) * 10) / 10,
      heightM: Math.round((h + growth * 0.6) * 10) / 10,
      underBranchH: ubh,
      crownWidth: cw,
      status: '活立木',
      origin: '天然',
      healthClass: '健康',
      tiltDeg: 2,
      remark: `样地中部 ${treeNo} 号桩`,
      round: 2,
      measuredAt: now - 6 * day,
      rev: 1,
      updatedAt: now - 6 * day,
    });
  });
  // 第 2 期新增进界木
  trees.push({
    id: newId('tree'),
    plotId,
    treeNo: '6',
    species: '色木槭',
    dbhCm: 6.2,
    heightM: 6.1,
    underBranchH: 1.8,
    crownWidth: 1.9,
    status: '活立木',
    origin: '天然',
    healthClass: '健康',
    tiltDeg: 1,
    remark: '样地东南 3m 进界木',
    round: 2,
    measuredAt: now - 6 * day,
    rev: 1,
    updatedAt: now - 6 * day,
  });
  trees.push({
    id: newId('tree'),
    plotId: plot2Id,
    treeNo: '1',
    species: '蒙古栎',
    dbhCm: 22.4,
    heightM: 13.2,
    underBranchH: 4.2,
    crownWidth: 4.1,
    status: '活立木',
    origin: '天然',
    healthClass: '健康',
    tiltDeg: 2,
    remark: '样地西侧',
    round: 1,
    measuredAt: now - 3 * day,
    rev: 1,
    updatedAt: now - 3 * day,
  });

  const regens: RegenShrub[] = [
    {
      id: newId('regen'),
      plotId,
      layer: '更新苗',
      species: '红松',
      heightCm: 32,
      count: 18,
      ageGroup: '3 年生',
      distribution: '团状',
      browseDamage: '轻度',
      round: 2,
      rev: 1,
      updatedAt: now - 6 * day,
    },
    {
      id: newId('regen'),
      plotId,
      layer: '更新苗',
      species: '紫椴',
      heightCm: 55,
      count: 9,
      ageGroup: '多年生',
      distribution: '均匀',
      browseDamage: '无',
      round: 2,
      rev: 1,
      updatedAt: now - 6 * day,
    },
    {
      id: newId('regen'),
      plotId,
      layer: '灌木',
      species: '毛榛子',
      heightCm: 120,
      count: 26,
      ageGroup: '多年生',
      distribution: '团状',
      browseDamage: '中度',
      round: 2,
      rev: 1,
      updatedAt: now - 6 * day,
    },
    {
      id: newId('regen'),
      plotId,
      layer: '草本',
      species: '苔草',
      heightCm: 22,
      count: 140,
      ageGroup: '多年生',
      distribution: '均匀',
      browseDamage: '无',
      round: 2,
      rev: 1,
      updatedAt: now - 6 * day,
    },
  ];

  await db.transaction('rw', db.plots, db.trees, db.regens, db.rechecks, async () => {
    await db.plots.bulkPut(plots);
    await db.trees.bulkPut(trees);
    await db.regens.bulkPut(regens);
  });
}
