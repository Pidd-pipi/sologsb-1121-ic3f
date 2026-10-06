import { create } from 'zustand';
import { bumpPlotRevision, db } from '../utils/db';
import { newId } from '../utils/id';
import type { Plot, PlotDraft } from '../types/plot';

interface PlotState {
  items: Plot[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: PlotDraft) => Promise<Plot>;
  update: (id: string, patch: Partial<Plot>, options?: { bumpRevision?: boolean }) => Promise<void>;
  toggleLock: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export const usePlotStore = create<PlotState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const rows = await db.plots.orderBy('createdAt').reverse().toArray();
    set({ items: rows, loaded: true });
  },
  async add(draft) {
    const now = Date.now();
    const record: Plot = {
      ...draft,
      id: newId('plot'),
      revision: 1,
      syncedRevision: 1,
      updatedAt: now,
      createdAt: now,
    };
    await db.plots.put(record);
    set({ items: [record, ...get().items] });
    return record;
  },
  async update(id, patch, options) {
    let full: Partial<Plot> = { ...patch };
    if (options?.bumpRevision ?? true) {
      // 本机改动 → 样地修订号 +1（此前的旧交换包随之失效）
      const revision = await bumpPlotRevision(id);
      full = { ...full, revision, updatedAt: Date.now() };
    }
    await db.plots.update(id, full);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...full } : it)) });
  },
  async toggleLock(id) {
    const target = get().items.find((it) => it.id === id);
    if (!target) return;
    // 锁定状态是本机工作流标记，不参与数据合并，不递增修订号
    await get().update(id, { locked: !target.locked }, { bumpRevision: false });
  },
  async remove(id) {
    await db.plots.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
}));
