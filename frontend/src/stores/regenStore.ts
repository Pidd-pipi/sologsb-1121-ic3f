import { create } from 'zustand';
import { db } from '../utils/db';
import { newId } from '../utils/id';
import { usePlotStore } from './plotStore';
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
    const record: RegenShrub = { ...draft, id: newId('regen'), rev: 1, updatedAt: now };
    await db.regens.put(record);
    set({ items: [...get().items, record] });
    await usePlotStore.getState().bumpRevision(record.plotId);
    return record;
  },
  async update(id, patch) {
    const target = get().items.find((it) => it.id === id);
    const nextPatch = { ...patch, updatedAt: Date.now() };
    await db.regens.update(id, nextPatch);
    set({ items: get().items.map((it) => (it.id === id ? { ...it, ...nextPatch } : it)) });
    if (target) await usePlotStore.getState().bumpRevision(target.plotId);
  },
  async remove(id) {
    const target = get().items.find((it) => it.id === id);
    await db.regens.delete(id);
    set({ items: get().items.filter((it) => it.id !== id) });
    if (target) await usePlotStore.getState().bumpRevision(target.plotId);
  },
  byPlot(plotId, round) {
    return get().items.filter((it) => it.plotId === plotId && (round === undefined || it.round === round));
  },
}));
