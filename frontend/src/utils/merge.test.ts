import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { db } from './db';
import {
  applyMerge,
  exportPlotPackage,
  listConflicts,
  normalizePackage,
  previewMerge,
  resolveConflict,
} from './merge';
import { useRegenStore } from '../stores/regenStore';
import { useTreeStore } from '../stores/treeStore';
import { newId } from './id';
import {
  EXCHANGE_FORMAT,
  MergeFailedError,
  StalePackageError,
  type ExchangePackage,
} from '../types/sync';
import type { Plot } from '../types/plot';
import type { RegenShrub } from '../types/regen';
import type { TreeRecord, TreeRecordDraft } from '../types/tree';

const PLOT_ID = 'plot_test';

function treeDraft(treeNo: string, round: number, dbhCm: number): TreeRecordDraft {
  const { id, measuredAt, rev, updatedAt, ...draft } = baseTree(treeNo, round, dbhCm);
  return draft;
}

function basePlot(): Plot {
  return {
    id: PLOT_ID,
    plotNo: 'FP-9001',
    locality: '测试林场 1 林班',
    lng: 128.9,
    lat: 47.18,
    shape: '方形',
    area: 600,
    elevation: 400,
    slope: 10,
    aspect: '东',
    forestType: '针阔混交林',
    canopyDensity: 0.7,
    dominantSpecies: '红松',
    surveyRound: 2,
    surveyedAt: 1000,
    crew: '一组',
    locked: false,
    revision: 1,
    syncedRevision: 1,
    updatedAt: 1000,
    createdAt: 500,
  };
}

function baseTree(treeNo: string, round: number, dbhCm: number): TreeRecord {
  return {
    id: `tree_${treeNo}_${round}`,
    plotId: PLOT_ID,
    treeNo,
    species: '红松',
    dbhCm,
    heightM: 15,
    underBranchH: 5,
    crownWidth: 4,
    status: '活立木',
    origin: '天然',
    healthClass: '健康',
    tiltDeg: 0,
    remark: '',
    round,
    measuredAt: 1000,
    rev: 1,
    updatedAt: 1000,
  };
}

function baseRegen(species: string, count: number): RegenShrub {
  return {
    id: `regen_${species}`,
    plotId: PLOT_ID,
    layer: '更新苗',
    species,
    heightCm: 40,
    count,
    ageGroup: '3 年生',
    distribution: '团状',
    browseDamage: '无',
    round: 2,
    rev: 1,
    updatedAt: 1000,
  };
}

/** 构造对方机器的交换包：plotRevision 3、基准 1，记录 rev 可自行调整 */
function makePackage(
  trees: TreeRecord[],
  regens: RegenShrub[],
  overrides: Partial<ExchangePackage> = {},
): ExchangePackage {
  return {
    format: EXCHANGE_FORMAT,
    formatVersion: 1,
    packageId: newId('pkg'),
    plotId: PLOT_ID,
    plotNo: 'FP-9001',
    plotRevision: 3,
    baseRevision: 1,
    round: 2,
    device: '外业-A',
    exportedAt: 2000,
    plot: { ...basePlot(), revision: 3 },
    trees,
    regens,
    ...overrides,
  };
}

async function treesOf(plotId = PLOT_ID): Promise<TreeRecord[]> {
  return db.trees.where('plotId').equals(plotId).toArray();
}

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  useTreeStore.setState({ items: [], loaded: false });
  useRegenStore.setState({ items: [], loaded: false });
});

describe('交换包导出', () => {
  it('写明样地修订号、基准修订号与期次，导出后同步点推进', async () => {
    await db.plots.put(basePlot());
    await useTreeStore.getState().add({
      plotId: PLOT_ID,
      treeNo: '1',
      species: '红松',
      dbhCm: 30,
      heightM: 15,
      underBranchH: 5,
      crownWidth: 4,
      status: '活立木',
      origin: '天然',
      healthClass: '健康',
      tiltDeg: 0,
      remark: '',
      round: 2,
    });

    const pkg = await exportPlotPackage(PLOT_ID, '外业-B');
    expect(pkg.format).toBe(EXCHANGE_FORMAT);
    expect(pkg.plotRevision).toBe(2); // 新增样木使修订号 1 → 2
    expect(pkg.baseRevision).toBe(1);
    expect(pkg.round).toBe(2);
    expect(pkg.device).toBe('外业-B');
    expect(pkg.trees).toHaveLength(1);
    expect(pkg.trees[0].rev).toBe(2);

    const plot = await db.plots.get(PLOT_ID);
    expect(plot?.syncedRevision).toBe(2);
  });
});

describe('离线合并', () => {
  it('单边新增的样木和更新苗直接并入，本机新增不被压掉', async () => {
    await db.plots.put(basePlot());
    await db.trees.put(baseTree('1', 2, 30));
    // 本机补录样木 2 号与一条更新苗（若整包覆盖会被压掉的那部分）
    await useTreeStore.getState().add(treeDraft('2', 2, 22));
    await useRegenStore.getState().add({
      plotId: PLOT_ID,
      layer: '更新苗',
      species: '紫椴',
      heightCm: 35,
      count: 8,
      ageGroup: '2 年生',
      distribution: '均匀',
      browseDamage: '无',
      round: 2,
    });

    // 对方包：共同的 1 号未动（rev 1），新增 3 号与一条更新苗（rev 2 > 基准 1）
    const pkg = makePackage(
      [baseTree('1', 2, 30), { ...baseTree('3', 2, 18), id: 'tree_remote_3', rev: 2 }],
      [{ ...baseRegen('云杉', 12), rev: 2 }],
    );
    const report = await applyMerge(pkg);

    expect(report.added).toBe(2);
    const trees = await treesOf();
    expect(trees.map((t) => t.treeNo).sort()).toEqual(['1', '2', '3']);
    expect(trees.find((t) => t.treeNo === '2')?.dbhCm).toBe(22); // 本机新增原样保留
    const regens = await db.regens.where('plotId').equals(PLOT_ID).toArray();
    expect(regens.map((r) => r.species).sort()).toEqual(['云杉', '紫椴']);
    // 合并后林分汇总已重算：3 株活立木 / 600 m² → 50 株/hm²
    expect(report.stand.perHa).toBe(50);
    // 修订号更新：max(本机 3, 包内 3) + 1
    const plot = await db.plots.get(PLOT_ID);
    expect(plot?.revision).toBe(report.newRevision);
    expect(plot?.syncedRevision).toBe(report.newRevision);
  });

  it('单边修改的记录直接并入（本机未动 → 采用对方值）', async () => {
    await db.plots.put(basePlot());
    await db.trees.put(baseTree('1', 2, 30)); // rev 1，本机未改

    const pkg = makePackage([{ ...baseTree('1', 2, 40), rev: 2 }], []);
    const report = await applyMerge(pkg);

    expect(report.updated).toBe(1);
    expect(report.conflicts).toHaveLength(0);
    const tree = (await treesOf())[0];
    expect(tree.dbhCm).toBe(40);
    expect(tree.rev).toBe(report.newRevision);
  });

  it('同一树号两边都有新测量值时保留本机值并列出待核冲突', async () => {
    await db.plots.put(basePlot());
    await db.trees.put(baseTree('1', 2, 30));
    // 本机重新测量：30 → 33（rev 2 > 同步点 1，视为本机改过）
    const local = (await treesOf())[0];
    await useTreeStore.setState({ items: [local] });
    await useTreeStore.getState().update(local.id, { dbhCm: 33 });

    // 对方也重新测量：30 → 40
    const pkg = makePackage([{ ...baseTree('1', 2, 40), rev: 2 }], []);
    const report = await applyMerge(pkg);

    expect(report.conflicts).toHaveLength(1);
    const tree = (await treesOf())[0];
    expect(tree.dbhCm).toBe(33); // 保留本机值

    const conflicts = await listConflicts('待核');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].treeNo).toBe('1');
    expect(conflicts[0].localValues.dbhCm).toBe(33);
    expect(conflicts[0].remoteValues.dbhCm).toBe(40);

    // 待核冲突可采用对方值处理
    await resolveConflict(conflicts[0].id, 'remote');
    expect((await treesOf())[0].dbhCm).toBe(40);
    expect((await listConflicts('待核'))).toHaveLength(0);
  });

  it('合并失败时恢复原记录', async () => {
    await db.plots.put(basePlot());
    await db.trees.put(baseTree('1', 2, 30));
    const before = await db.plots.get(PLOT_ID);

    const pkg = makePackage([{ ...baseTree('9', 2, 12), id: 'tree_remote_9', rev: 2 }], []);
    const spy = vi.spyOn(db.trees, 'bulkPut').mockRejectedValueOnce(new Error('模拟磁盘写入失败'));

    const attempt = applyMerge(pkg);
    await expect(attempt).rejects.toThrow(MergeFailedError);
    await expect(attempt).rejects.toThrow(/已恢复原记录/);
    spy.mockRestore();

    // 原记录完好：样木未增加，修订号未变
    expect(await treesOf()).toHaveLength(1);
    const after = await db.plots.get(PLOT_ID);
    expect(after?.revision).toBe(before?.revision);
    // 失败已记入合并日志
    const logs = await db.merges.toArray();
    expect(logs.some((l) => l.status === '失败已恢复')).toBe(true);
  });

  it('本机修订号更新后旧交换包立即失效，并列出受影响对象', async () => {
    await db.plots.put(basePlot());
    await db.trees.put(baseTree('1', 2, 30));

    const pkg = makePackage([{ ...baseTree('1', 2, 40), rev: 2 }], []);
    await applyMerge(pkg); // 合并成功 → 本机修订号升到 4

    // 本机继续改动（树号 1 胸径 40 → 41）
    const local = (await treesOf())[0];
    await useTreeStore.setState({ items: [local] });
    await useTreeStore.getState().update(local.id, { dbhCm: 41 });

    // 同一个旧交换包再次导入 → 立即失效
    let caught: unknown;
    try {
      await applyMerge(pkg);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StalePackageError);
    const stale = caught as StalePackageError;
    expect(stale.message).toMatch(/失效/);
    // 受影响对象：树号 1（本机 41 vs 包内 40）
    expect(stale.affected.some((a) => a.kind === '样木' && a.key.includes('树号 1'))).toBe(true);
    // 本机数据未被旧包改动
    expect((await treesOf())[0].dbhCm).toBe(41);
  });

  it('同一交换包重复导入被拒绝', async () => {
    const pkg = makePackage([{ ...baseTree('1', 2, 30), rev: 2 }], [], {
      plotId: 'plot_new',
      plotNo: 'FP-9002',
      plot: { ...basePlot(), id: 'plot_new', plotNo: 'FP-9002', revision: 3 },
      trees: [],
    });
    const first = await applyMerge({ ...pkg, trees: [{ ...baseTree('1', 2, 30), plotId: 'plot_new', rev: 2 }] });
    expect(first.newRevision).toBe(3); // 新样地：采用包内修订号

    await expect(
      applyMerge({ ...pkg, trees: [{ ...baseTree('1', 2, 30), plotId: 'plot_new', rev: 2 }] }),
    ).rejects.toThrow(StalePackageError);
  });

  it('合并后复查比对按合并后数据重算并替换旧存档', async () => {
    await db.plots.put(basePlot());
    await db.trees.bulkPut([baseTree('1', 1, 28), baseTree('1', 2, 30), baseTree('2', 2, 20)]);
    // 旧的比对存档（将被重算替换）
    await db.rechecks.put({
      id: 'diff_stale',
      plotId: PLOT_ID,
      baseRound: 1,
      targetRound: 2,
      treeNo: '99',
      species: '红松',
      dbhGrowth: 0,
      heightGrowth: 0,
      statusChange: '',
      missingReason: '',
      generatedAt: 1,
    });

    const pkg = makePackage(
      [baseTree('1', 1, 28), baseTree('1', 2, 30), baseTree('2', 2, 20), { ...baseTree('3', 2, 15), id: 'tree_remote_3', rev: 2 }],
      [],
    );
    const report = await applyMerge(pkg);

    expect(report.recheckRegenerated).toBe(true);
    const diffs = await db.rechecks.where('plotId').equals(PLOT_ID).toArray();
    expect(diffs.some((d) => d.treeNo === '99')).toBe(false); // 旧存档已替换
    expect(diffs.map((d) => d.treeNo).sort()).toEqual(['1', '2', '3']);
    expect(diffs.find((d) => d.treeNo === '3')?.missingReason).toBe('本期新增进界木');
  });

  it('本机已删除的记录不会被对方包复活', async () => {
    await db.plots.put(basePlot());
    await db.trees.put(baseTree('5', 2, 25));
    // 本机删除 5 号（登记墓碑）
    const local = (await treesOf())[0];
    await useTreeStore.setState({ items: [local] });
    await useTreeStore.getState().remove(local.id);
    expect(await treesOf()).toHaveLength(0);

    // 对方包仍带着基准期时的 5 号（未再改动）
    const pkg = makePackage([baseTree('5', 2, 25)], []);
    const report = await applyMerge(pkg);

    expect(report.tombstoned).toBe(1);
    expect(await treesOf()).toHaveLength(0); // 未复活
  });

  it('本机删除后对方在基准期又改过 → 按对方新值并入', async () => {
    await db.plots.put(basePlot());
    await db.trees.put(baseTree('5', 2, 25));
    const local = (await treesOf())[0];
    await useTreeStore.setState({ items: [local] });
    await useTreeStore.getState().remove(local.id);

    const pkg = makePackage([{ ...baseTree('5', 2, 27), rev: 2 }], []); // 对方改过重测
    await applyMerge(pkg);

    const trees = await treesOf();
    expect(trees).toHaveLength(1);
    expect(trees[0].dbhCm).toBe(27);
  });

  it('本机没有的样地整包导入为新样地', async () => {
    const pkg = makePackage(
      [
        { ...baseTree('1', 2, 30), id: 't1', plotId: 'plot_x', rev: 2 },
        { ...baseTree('2', 2, 22), id: 't2', plotId: 'plot_x', rev: 2 },
      ],
      [{ ...baseRegen('红松', 10), id: 'r1', plotId: 'plot_x', rev: 2 }],
      {
        plotId: 'plot_x',
        plotNo: 'FP-9010',
        plotRevision: 4,
        plot: { ...basePlot(), id: 'plot_x', plotNo: 'FP-9010', revision: 4 },
      },
    );

    const preview = await previewMerge(pkg);
    expect(preview.isNewPlot).toBe(true);
    expect(preview.added).toBe(3);

    const report = await applyMerge(pkg);
    expect(report.newRevision).toBe(4);
    const plot = await db.plots.get('plot_x');
    expect(plot?.plotNo).toBe('FP-9010');
    expect(plot?.syncedRevision).toBe(4);
    expect(await treesOf('plot_x')).toHaveLength(2);
  });
});

describe('旧数据升级', () => {
  it('缺少 rev 字段的旧交换包按新结构补齐后可合并', async () => {
    await db.plots.put(basePlot());
    await db.trees.put(baseTree('1', 2, 30));

    // 模拟旧格式：无 formatVersion/plotRevision/rev/updatedAt
    const legacyRaw = {
      format: EXCHANGE_FORMAT,
      packageId: 'pkg_legacy',
      plotId: PLOT_ID,
      plotNo: 'FP-9001',
      device: '旧设备',
      plot: { ...basePlot(), revision: undefined, syncedRevision: undefined, updatedAt: undefined },
      trees: [{ ...baseTree('2', 2, 19), id: 'tree_old_2', rev: undefined, updatedAt: undefined }],
      regens: [],
    };
    const pkg = normalizePackage(JSON.parse(JSON.stringify(legacyRaw)));
    expect(pkg.plotRevision).toBe(1);
    expect(pkg.trees[0].rev).toBe(1);

    const report = await applyMerge(pkg);
    expect(report.added).toBe(1);
    expect((await treesOf()).map((t) => t.treeNo).sort()).toEqual(['1', '2']);
  });

  it('v2 结构的老库打开时自动升级：补修订号与记录时间戳', async () => {
    await db.delete(); // 清掉 beforeEach 建出的 v3 库，模拟老库
    const legacy = new Dexie('gbforestplot');
    legacy.version(1).stores({
      plots: 'id, plotNo, locality, forestType, surveyRound, createdAt',
      trees: 'id, plotId, treeNo, species, round, status',
      regens: 'id, plotId, layer, species, round',
      rechecks: 'id, plotId, baseRound, targetRound, treeNo',
    });
    legacy.version(2).stores({
      plots: 'id, plotNo, locality, forestType, surveyRound, locked, createdAt',
      trees: 'id, plotId, treeNo, species, round, status, measuredAt',
      regens: 'id, plotId, layer, species, round, heightCm',
      rechecks: 'id, plotId, baseRound, targetRound, treeNo, generatedAt',
    });
    await legacy.open();
    await legacy.table('plots').put({ ...basePlot(), id: 'p_old', revision: undefined, syncedRevision: undefined, updatedAt: undefined });
    await legacy.table('trees').put({ ...baseTree('1', 2, 30), id: 't_old', plotId: 'p_old', rev: undefined, updatedAt: undefined, measuredAt: 1234 });
    await legacy.close();

    await db.open(); // 触发 v3 迁移
    const plot = await db.plots.get('p_old');
    expect(plot?.revision).toBe(1);
    expect(plot?.syncedRevision).toBe(1);
    expect(plot?.updatedAt).toBe(500);
    const tree = await db.trees.get('t_old');
    expect(tree?.rev).toBe(1);
    expect(tree?.updatedAt).toBe(1234); // 沿用 measuredAt
  });
});
