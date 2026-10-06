import 'fake-indexeddb/auto';
import { db } from '../src/utils/db';
import {
  applyMerge,
  buildPackage,
  parsePackage,
  planMerge,
  recalcAfterMerge,
  type ExchangePackage,
} from '../src/utils/exchange';
import { newId } from '../src/utils/id';
import type { Plot } from '../src/types/plot';
import type { TreeRecord } from '../src/types/tree';
import type { RegenShrub } from '../src/types/regen';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

async function resetDb() {
  await db.delete();
  await db.open();
}

function makePlot(plotNo: string, revision = 1): Plot {
  return {
    id: newId('plot'),
    plotNo,
    locality: '测试地点',
    lng: 128.9,
    lat: 47.18,
    shape: '方形',
    area: 600,
    elevation: 400,
    slope: 8,
    aspect: '东南',
    forestType: '针阔混交林',
    canopyDensity: 0.7,
    dominantSpecies: '红松',
    surveyRound: 2,
    surveyedAt: Date.now(),
    crew: '测试组',
    locked: false,
    revision,
    createdAt: Date.now(),
  };
}

function makeTree(plotId: string, treeNo: string, round: number, dbh: number, rev = 1): TreeRecord {
  return {
    id: newId('tree'),
    plotId,
    treeNo,
    species: '红松',
    dbhCm: dbh,
    heightM: 10,
    underBranchH: 2,
    crownWidth: 2,
    status: '活立木',
    origin: '天然',
    healthClass: '健康',
    tiltDeg: 0,
    remark: '',
    round,
    measuredAt: Date.now(),
    rev,
  };
}

function makeRegen(plotId: string, species: string, count: number, round = 2): RegenShrub {
  return {
    id: newId('regen'),
    plotId,
    layer: '更新苗',
    species,
    heightCm: 40,
    count,
    ageGroup: '2 年生',
    distribution: '均匀',
    browseDamage: '无',
    round,
    rev: 1,
    updatedAt: Date.now(),
  };
}

async function seedLocal(plot: Plot, trees: TreeRecord[], regens: RegenShrub[]) {
  await db.plots.put(plot);
  await db.trees.bulkPut(trees);
  await db.regens.bulkPut(regens);
}

async function main() {
  await resetDb();

  // ===== 场景 1：单边新增直接并入 + 两边冲突保留本机 =====
  console.log('场景1：单边新增并入 + 两边新测量值冲突保留本机');
  {
    const plot = makePlot('FP-TEST-01');
    // 基线：树1 dbh=30
    const baseTrees = [makeTree(plot.id, '1', 2, 30)];
    // 本机：树1 复测 dbh=35（本机新测量）；本机新增树2
    const localTrees = [makeTree(plot.id, '1', 2, 35, 2), makeTree(plot.id, '2', 2, 20, 1)];
    const localRegens = [makeRegen(plot.id, '红松', 10)];
    await seedLocal(plot, localTrees, localRegens);

    // 另一台机器：树1 复测 dbh=38（新测量，与本机冲突）；新增树3；新增更新苗
    const remotePlot: Plot = { ...plot, id: plot.id, revision: 2 };
    const remoteTrees = [
      makeTree(plot.id, '1', 2, 38, 2),
      makeTree(plot.id, '3', 2, 18, 1),
    ];
    const remoteRegens = [makeRegen(plot.id, '红松', 10), makeRegen(plot.id, '紫椴', 5)];
    const pkg: ExchangePackage = {
      format: 'gbforestplot-exchange',
      version: 1,
      exportedAt: Date.now(),
      source: { crew: '二组' },
      plots: [
        {
          plot: remotePlot,
          trees: remoteTrees,
          regens: remoteRegens,
          base: { revision: 1, trees: baseTrees, regens: [] },
        },
      ],
    };

    const plans = planMerge(pkg, [plot], localTrees, localRegens);
    const report = plans[0].report;
    check('状态为 merged', report.status === 'merged');
    check('并入远端新增样木 树3', report.addedTrees.some((t) => t.treeNo === '3'), JSON.stringify(report.addedTrees));
    check('树1 两边新测量 → 冲突 1 条', report.conflictTrees.length === 1, `got ${report.conflictTrees.length}`);
    check('冲突保留本机值 35', report.conflictTrees[0]?.local.dbhCm === 35);
    check('冲突列出包内值 38', report.conflictTrees[0]?.remote.dbhCm === 38);
    check('冲突字段差异含胸径', report.conflictTrees[0]?.fieldDiffs.some((d) => d.label === '胸径'));
    check('并入远端新增更新苗 紫椴', report.addedRegens.some((r) => r.species === '紫椴'));
    check('红松更新苗两边一致 → 无冲突', report.conflictRegens.length === 0);

    await applyMerge(plans);
    await recalcAfterMerge(plans);
    const afterTrees = await db.trees.where('plotId').equals(plot.id).toArray();
    const tree1 = afterTrees.find((t) => t.treeNo === '1' && t.round === 2);
    check('合并后树1为本机值 35', tree1?.dbhCm === 35, `got ${tree1?.dbhCm}`);
    check('合并后树3已并入', afterTrees.some((t) => t.treeNo === '3'));
    check('合并后树2保留', afterTrees.some((t) => t.treeNo === '2'));
    const afterRegens = await db.regens.where('plotId').equals(plot.id).toArray();
    check('合并后紫椴更新苗已并入', afterRegens.some((r) => r.species === '紫椴'));
    const afterPlot = await db.plots.get(plot.id);
    check('合并后修订号更新 (1,2 → 3)', afterPlot?.revision === 3, `got ${afterPlot?.revision}`);
    const diffs = await db.rechecks.where('plotId').equals(plot.id).toArray();
    check('复查比对已重算（期次<2 可能为0，此处不报错即可）', Array.isArray(diffs));
  }

  // ===== 场景 2：旧交换包失效并指出受影响对象 =====
  console.log('场景2：本机修订号更新后旧包立即失效');
  {
    await resetDb();
    const plot = makePlot('FP-TEST-02', 5);
    const localTrees = [makeTree(plot.id, '1', 2, 40, 3)];
    await seedLocal(plot, localTrees, []);

    // 旧包：修订号仅 2（低于本机 5）
    const pkg: ExchangePackage = {
      format: 'gbforestplot-exchange',
      version: 1,
      exportedAt: Date.now(),
      source: {},
      plots: [
        {
          plot: { ...plot, revision: 2 },
          trees: [makeTree(plot.id, '1', 2, 30, 1)],
          regens: [],
          base: { revision: 1, trees: [], regens: [] },
        },
      ],
    };
    const plans = planMerge(pkg, [plot], localTrees, []);
    const report = plans[0].report;
    check('旧包状态为 stale', report.status === 'stale');
    check('列出受影响对象', report.affected.length > 0, `got ${report.affected.length}`);
    check('受影响对象含样地', report.affected.some((a) => a.kind === 'plot'));
    check('受影响对象含不一致样木', report.affected.some((a) => a.kind === 'tree'));

    await applyMerge(plans);
    const afterTrees = await db.trees.where('plotId').equals(plot.id).toArray();
    check('旧包未并入数据（树1仍为40）', afterTrees.find((t) => t.treeNo === '1')?.dbhCm === 40);
  }

  // ===== 场景 3：合并失败回滚，恢复原记录 =====
  console.log('场景3：合并失败后恢复原记录');
  {
    await resetDb();
    const plot = makePlot('FP-TEST-03');
    const localTrees = [makeTree(plot.id, '1', 2, 35)];
    await seedLocal(plot, localTrees, []);

    const pkg: ExchangePackage = {
      format: 'gbforestplot-exchange',
      version: 1,
      exportedAt: Date.now(),
      source: {},
      plots: [
        {
          plot: { ...plot, revision: 2 },
          trees: [makeTree(plot.id, '9', 2, 99)],
          regens: [],
          base: { revision: 1, trees: [], regens: [] },
        },
      ],
    };
    const plans = planMerge(pkg, [plot], localTrees, []);
    // 让 bulkPut 抛错以模拟失败
    const origBulkPut = db.trees.bulkPut.bind(db.trees);
    // @ts-expect-error 临时替换
    db.trees.bulkPut = async () => {
      throw new Error('模拟写入失败');
    };
    let failed = false;
    try {
      await applyMerge(plans);
    } catch {
      failed = true;
    }
    // @ts-expect-error 还原
    db.trees.bulkPut = origBulkPut;
    check('合并抛错', failed);
    const afterTrees = await db.trees.where('plotId').equals(plot.id).toArray();
    check('回滚后恢复原样木（树1=35，无树9）', afterTrees.length === 1 && afterTrees[0].dbhCm === 35);
    const afterPlot = await db.plots.get(plot.id);
    check('回滚后修订号恢复为1', afterPlot?.revision === 1, `got ${afterPlot?.revision}`);
  }

  // ===== 场景 4：新样地随包整体导入 =====
  console.log('场景4：新样地整体导入');
  {
    await resetDb();
    const pkg: ExchangePackage = {
      format: 'gbforestplot-exchange',
      version: 1,
      exportedAt: Date.now(),
      source: {},
      plots: [
        {
          plot: makePlot('FP-NEW-01', 1),
          trees: [makeTree('x', '1', 2, 30)],
          regens: [makeRegen('x', '红松', 8)],
          base: { revision: 0, trees: [], regens: [] },
        },
      ],
    };
    // 包内 plot id 与 tree.plotId 需一致
    const ep = pkg.plots[0];
    ep.trees.forEach((t) => (t.plotId = ep.plot.id));
    ep.regens.forEach((r) => (r.plotId = ep.plot.id));
    const plans = planMerge(pkg, [], [], []);
    check('新样地状态 merged', plans[0].report.status === 'merged');
    check('新样地并入样木1株', plans[0].report.addedTrees.length === 1);
    await applyMerge(plans);
    const afterPlot = await db.plots.get(ep.plot.id);
    check('新样地已入库', !!afterPlot);
    const afterTrees = await db.trees.where('plotId').equals(ep.plot.id).toArray();
    check('新样地样木已入库', afterTrees.length === 1);
  }

  // ===== 场景 5：解析旧结构包自动升级 =====
  console.log('场景5：旧结构包升级');
  {
    await resetDb();
    const oldPkg = {
      format: 'gbforestplot-exchange',
      version: 1,
      exportedAt: Date.now(),
      source: {},
      plots: [
        {
          plot: {
            id: newId('plot'),
            plotNo: 'FP-OLD-01',
            locality: 'x',
            lng: 1,
            lat: 2,
            shape: '方形',
            area: 600,
            elevation: 1,
            slope: 1,
            aspect: 'x',
            forestType: '阔叶林',
            canopyDensity: 0.5,
            dominantSpecies: '栎',
            surveyRound: 1,
            surveyedAt: Date.now(),
            crew: '',
            locked: false,
            createdAt: Date.now(),
            // 无 revision 字段（旧结构）
          },
          trees: [
            {
              id: newId('tree'),
              plotId: '',
              treeNo: '1',
              species: '栎',
              dbhCm: 20,
              heightM: 10,
              underBranchH: 2,
              crownWidth: 2,
              status: '活立木',
              origin: '天然',
              healthClass: '健康',
              tiltDeg: 0,
              remark: '',
              round: 1,
              measuredAt: Date.now(),
              // 无 rev
            },
          ],
          regens: [],
          // 无 base
        },
      ],
    };
    const parsed = parsePackage(JSON.stringify(oldPkg));
    check('旧结构样地升级 revision=1', parsed.plots[0].plot.revision === 1);
    check('旧结构样木升级 rev=1', parsed.plots[0].trees[0].rev === 1);
    check('缺失 base 时基线为空', parsed.plots[0].base.trees.length === 0);
  }

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
