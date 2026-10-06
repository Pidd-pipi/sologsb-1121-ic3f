import { db } from './db';
import { newId } from './id';
import type { RecheckDiff } from '../types/recheck';
import type { TreeRecord } from '../types/tree';

function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 由两期样木记录生成逐株比对表（与复查比对页同一口径） */
export function calcDiffs(
  trees: TreeRecord[],
  plotId: string,
  baseRound: number,
  targetRound: number,
): RecheckDiff[] {
  const baseList = trees.filter((t) => t.plotId === plotId && t.round === baseRound);
  const targetList = trees.filter((t) => t.plotId === plotId && t.round === targetRound);
  const baseMap = new Map<string, TreeRecord>();
  baseList.forEach((t) => baseMap.set(t.treeNo, t));
  const targetMap = new Map<string, TreeRecord>();
  targetList.forEach((t) => targetMap.set(t.treeNo, t));
  const allNos = Array.from(new Set([...baseMap.keys(), ...targetMap.keys()])).sort((a, b) =>
    a.localeCompare(b, 'zh-Hans-CN', { numeric: true }),
  );

  return allNos.map((treeNo) => {
    const b = baseMap.get(treeNo);
    const t = targetMap.get(treeNo);
    const baseDbh = b?.dbhCm;
    const targetDbh = t?.dbhCm;
    const dbhGrowth = baseDbh !== undefined && targetDbh !== undefined ? r2(targetDbh - baseDbh) : 0;
    const heightGrowth = b && t ? r2(t.heightM - b.heightM) : 0;
    const statusChange = b && t && b.status !== t.status ? `${b.status} → ${t.status}` : '';
    const missingReason = !t ? '本期未复测（疑似采伐或倒伏）' : !b ? '本期新增进界木' : '';
    return {
      id: newId('diff'),
      plotId,
      baseRound,
      targetRound,
      treeNo,
      species: t?.species ?? b?.species ?? '',
      baseDbhCm: baseDbh,
      targetDbhCm: targetDbh,
      baseHeightM: b?.heightM,
      targetHeightM: t?.heightM,
      dbhGrowth,
      heightGrowth,
      statusChange,
      missingReason,
      generatedAt: Date.now(),
    };
  });
}

/**
 * 合并后重算某样地的复查比对：清空旧比对结果，按最近两期重新生成并写回。
 * 返回生成的比对条数。
 */
export async function recalcRecheckDiffs(plotId: string): Promise<number> {
  const trees = await db.trees.where('plotId').equals(plotId).toArray();
  const rounds = Array.from(new Set(trees.map((t) => t.round))).sort((a, b) => a - b);
  await db.rechecks.where('plotId').equals(plotId).delete();
  if (rounds.length < 2) return 0;
  const diffs = calcDiffs(trees, plotId, rounds[rounds.length - 2], rounds[rounds.length - 1]);
  await db.rechecks.bulkPut(diffs);
  return diffs.length;
}
