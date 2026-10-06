import { create } from 'zustand';
import { bumpPlotRevision, clearDeletion, db, recordDeletion, treeBizKey } from '../utils/db';
import { newId } from '../utils/id';
import type { TreeRecord, TreeRecordDraft } from '../types/tree';

interface TreeState {
  items: TreeRecord[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: TreeRecordDraft) => Promise<TreeRecord>;
  addMany: (drafts: TreeRecordDraft[]) => Promise<TreeRecord[]>;
  update: (id: string, patch: Partial<TreeRecord>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  byPlot: (plotId: string, round?: number) => TreeRecord[];
}

export const useTreeStore = create<TreeState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const rows = await db.trees.toArray();
    rows.sort((a, b) => a.round - b.round || a.treeNo.localeCompare(b.treeNo));
    set({ items: rows, loaded: true });
  },
  async add(draft) {
    const now = Date.now();
    const rev = await bumpPlotRevision(draft.plotId);
    const record: TreeRecord = { ...draft, id: newId('tree'), measuredAt: now, rev, updatedAt: now };
    await db.trees.put(record);
    await clearDeletion(draft.plotId, treeBizKey(draft.treeNo, draft.round));
    set({ items: [...get().items, record] });
    return record;
  },
  async addMany(drafts) {
    if (drafts.length === 0) return [];
    const now = Date.now();
    const rev = await bumpPlotRevision(drafts[0].plotId);
    const records: TreeRecord[] = drafts.map((d) => ({
      ...d,
      id: newId('tree'),
      measuredAt: now,
      rev,
      updatedAt: now,
    }));
    await db.trees.bulkPut(records);
    await Promise.all(drafts.map((d) => clearDeletion(d.plotId, treeBizKey(d.treeNo, d.round))));
    set({ items: [...get().items, ...records] });
    return records;
  },
  async update(id, patch) {
    const current = get().items.find((it) => it.id === id);
    const rev = current ? await bumpPlotRevision(current.plotId) : 1;
    const now = Date.now();
    await db.trees.update(id, { ...patch, rev, updatedAt: now });
    set({
      items: get().items.map((it) => (it.id === id ? { ...it, ...patch, rev, updatedAt: now } : it)),
    });
  },
  async remove(id) {
    const current = get().items.find((it) => it.id === id);
    if (current) {
      const rev = await bumpPlotRevision(current.plotId);
      await recordDeletion(current.plotId, treeBizKey(current.treeNo, current.round), rev);
    }
    await db.trees.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
  byPlot(plotId, round) {
    return get()
      .items.filter((it) => it.plotId === plotId && (round === undefined || it.round === round))
      .sort((a, b) => a.treeNo.localeCompare(b.treeNo, 'zh-Hans-CN', { numeric: true }));
  },
}));
