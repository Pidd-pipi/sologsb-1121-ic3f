/** 更新层位 */
export type RegenLayer = '更新苗' | '灌木' | '草本';

export const REGEN_LAYERS: RegenLayer[] = ['更新苗', '灌木', '草本'];

export const AGE_GROUPS = ['1 年生', '2 年生', '3 年生', '多年生'];

export type Distribution = '均匀' | '团状';

export const DISTRIBUTIONS: Distribution[] = ['均匀', '团状'];

export type BrowseDamage = '无' | '轻度' | '中度' | '重度';

export const BROWSE_DAMAGES: BrowseDamage[] = ['无', '轻度', '中度', '重度'];

/** 更新苗与灌木层样方记录 */
export interface RegenShrub {
  id: string;
  plotId: string;
  layer: RegenLayer;
  species: string;
  /** 高度 cm */
  heightCm: number;
  /** 株数 */
  count: number;
  ageGroup: string;
  distribution: Distribution;
  browseDamage: BrowseDamage;
  round: number;
  /** 记录修订号：本机每改一次 +1，用于合并时判断「单边改过」 */
  rev: number;
  updatedAt: number;
}

export type RegenShrubDraft = Omit<RegenShrub, 'id' | 'rev' | 'updatedAt'>;
