import type { RecheckDiff } from '../types/recheck';
import type { TreeRecord } from '../types/tree';
import { newId } from './id';

function r2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 逐株比对：上期 → 本期，标记缺失与状态变化。
 * 复查比对页与离线合并后的重算共用。
 */
export function buildRecheckDiffs(
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

/** 样地最新两期期次（不足两期返回 null） */
export function latestRoundPair(trees: TreeRecord[], plotId: string): [number, number] | null {
  const rounds = Array.from(new Set(trees.filter((t) => t.plotId === plotId).map((t) => t.round))).sort(
    (a, b) => a - b,
  );
  if (rounds.length < 2) return null;
  return [rounds[rounds.length - 2], rounds[rounds.length - 1]];
}
