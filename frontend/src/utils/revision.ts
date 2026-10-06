import { db, type SyncBase } from './db';

/**
 * 样地修订号自增。本机每发生一次数据变更（样地/样木/更新苗增删改）即调用，
 * 修订号 +1 后，旧交换包（修订号 ≤ 本机）立即失效。
 * 返回新修订号。
 */
export async function bumpPlotRevision(plotId: string): Promise<number> {
  const plot = await db.plots.get(plotId);
  if (!plot) return 0;
  const next = (plot.revision ?? 0) + 1;
  await db.plots.update(plotId, { revision: next });
  return next;
}

/** 读取某样地的最近同步基线（三方合并参考） */
export async function getSyncBase(plotId: string): Promise<SyncBase | undefined> {
  return db.syncbases.get(plotId);
}

/** 写入某样地的同步基线（合并/导出后调用） */
export async function setSyncBase(base: SyncBase): Promise<void> {
  await db.syncbases.put(base);
}
