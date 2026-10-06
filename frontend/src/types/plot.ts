/** 样地形状 */
export type PlotShape = '方形' | '圆形';

export const PLOT_SHAPES: PlotShape[] = ['方形', '圆形'];

export const FOREST_TYPES = ['针叶林', '阔叶林', '针阔混交林', '灌木林', '竹林'];

/** 固定样地 */
export interface Plot {
  id: string;
  /** 样地号 */
  plotNo: string;
  locality: string;
  lng: number;
  lat: number;
  shape: PlotShape;
  /** 面积 m² */
  area: number;
  /** 海拔 m */
  elevation: number;
  /** 坡度 ° */
  slope: number;
  /** 坡向 */
  aspect: string;
  forestType: string;
  /** 郁闭度 0-1 */
  canopyDensity: number;
  dominantSpecies: string;
  /** 复查期次 */
  surveyRound: number;
  surveyedAt: number;
  /** 调查组 */
  crew: string;
  /** 往期数据是否锁定 */
  locked: boolean;
  /** 样地修订号：本机每次改动（样木/更新苗/样地字段）递增 */
  revision: number;
  /** 上次导入/导出交换包时的修订号，用于判断同步点之后的本机改动 */
  syncedRevision: number;
  /** 最近一次改动时间 */
  updatedAt: number;
  createdAt: number;
}

export type PlotDraft = Omit<Plot, 'id' | 'createdAt' | 'revision' | 'syncedRevision' | 'updatedAt'>;
