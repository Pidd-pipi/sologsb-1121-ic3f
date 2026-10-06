import { create } from 'zustand';
import { bumpPlotRevision, clearDeletion, db, recordDeletion, regenBizKey } from '../utils/db';
import { newId } from '../utils/id';
import type { RegenShrub, RegenShrubDraft } from '../types/regen';

interface RegenState {
  items: RegenShrub[];
  loaded: boolean;
  load: () => Promise<void>;
  add: (draft: RegenShrubDraft) => Promise<RegenShrub>;
  update: (id: string, patch: Partial<RegenShrub>) => Promise<void>;
  remove: (id: string) => Promise<void>;
  byPlot: (plotId: string, round?: number) => RegenShrub[];
}

export const useRegenStore = create<RegenState>((set, get) => ({
  items: [],
  loaded: false,
  async load() {
    const rows = await db.regens.toArray();
    rows.sort((a, b) => a.round - b.round || a.layer.localeCompare(b.layer));
    set({ items: rows, loaded: true });
  },
  async add(draft) {
    const now = Date.now();
    const rev = await bumpPlotRevision(draft.plotId);
    const record: RegenShrub = { ...draft, id: newId('regen'), rev, updatedAt: now };
    await db.regens.put(record);
    await clearDeletion(draft.plotId, regenBizKey(draft.layer, draft.species, draft.round));
    set({ items: [...get().items, record] });
    return record;
  },
  async update(id, patch) {
    const current = get().items.find((it) => it.id === id);
    const rev = current ? await bumpPlotRevision(current.plotId) : 1;
    const now = Date.now();
    await db.regens.update(id, { ...patch, rev, updatedAt: now });
    set({
      items: get().items.map((it) => (it.id === id ? { ...it, ...patch, rev, updatedAt: now } : it)),
    });
  },
  async remove(id) {
    const current = get().items.find((it) => it.id === id);
    if (current) {
      const rev = await bumpPlotRevision(current.plotId);
      await recordDeletion(current.plotId, regenBizKey(current.layer, current.species, current.round), rev);
    }
    await db.regens.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
  },
  byPlot(plotId, round) {
    return get().items.filter((it) => it.plotId === plotId && (round === undefined || it.round === round));
  },
}));
