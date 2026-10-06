import type { Plot } from './plot';
import type { TreeRecord } from './tree';
import type { RegenShrub } from './regen';

/** 交换包格式标识 */
export const EXCHANGE_FORMAT = 'gbforestplot-exchange';
/** 当前交换包格式版本（缺少 rev 字段的旧包按 0 处理并自动升级） */
export const EXCHANGE_FORMAT_VERSION = 1;

/** 离线交换包：写明样地修订号与期次，携带样地全量记录 */
export interface ExchangePackage {
  format: typeof EXCHANGE_FORMAT;
  formatVersion: number;
  packageId: string;
  plotId: string;
  plotNo: string;
  /** 导出方当前样地修订号 */
  plotRevision: number;
  /** 导出方上次同步点修订号（其记录 rev > baseRevision 视为对方改过） */
  baseRevision: number;
  /** 导出方样地当前期次 */
  round: number;
  device: string;
  exportedAt: number;
  plot: Plot;
  trees: TreeRecord[];
  regens: RegenShrub[];
}

/** 待核冲突：同一业务键两边都有新值时保留本机值并登记 */
export interface MergeConflict {
  id: string;
  plotId: string;
  kind: '样木' | '更新苗' | '样地';
  /** 样木为树号，更新苗为 层位/树种，样地为字段名 */
  treeNo: string;
  round: number;
  species: string;
  /** 本机保留值（关键字段快照） */
  localValues: Record<string, string | number | undefined>;
  /** 对方包内值 */
  remoteValues: Record<string, string | number | undefined>;
  packageId: string;
  device: string;
  at: number;
  status: '待核' | '已采用对方' | '已保持本机';
}

/** 合并日志 */
export interface MergeLog {
  id: string;
  plotId: string;
  plotNo: string;
  packageId: string;
  device: string;
  at: number;
  added: number;
  updated: number;
  skipped: number;
  tombstoned: number;
  conflictCount: number;
  fromRevision: number;
  toRevision: number;
  status: '成功' | '失败已恢复' | '已拒绝';
  message: string;
}

/** 删除墓碑：本机删除记录后登记，合并时避免被对方包复活 */
export interface DeletionRecord {
  /** `${plotId}:${key}` */
  id: string;
  plotId: string;
  /** tree:{treeNo}:{round} 或 regen:{layer}:{species}:{round} */
  key: string;
  /** 删除时的样地修订号 */
  rev: number;
  at: number;
}

/** 旧交换包失效时列出的受影响对象 */
export interface AffectedObject {
  kind: '样地' | '样木' | '更新苗';
  key: string;
  detail: string;
}

/** 合并结果报告 */
export interface MergeReport {
  plotId: string;
  plotNo: string;
  packageId: string;
  at: number;
  added: number;
  updated: number;
  skipped: number;
  tombstoned: number;
  conflicts: MergeConflict[];
  fromRevision: number;
  newRevision: number;
  /** 复查比对是否已按合并后数据重算 */
  recheckRegenerated: boolean;
  /** 合并后重算的林分因子 */
  stand: {
    perHa: number;
    meanDbh: number;
    meanHeight: number;
    basalAreaPerHa: number;
    regenPerHa: number;
    shrubPerHa: number;
  };
}

/** 合并预演（导入前给用户确认） */
export interface MergePreview {
  plotId: string;
  plotNo: string;
  isNewPlot: boolean;
  added: number;
  updated: number;
  skipped: number;
  tombstoned: number;
  conflictCount: number;
}

/** 旧交换包失效错误：携带受影响对象清单 */
export class StalePackageError extends Error {
  affected: AffectedObject[];
  constructor(message: string, affected: AffectedObject[]) {
    super(message);
    this.name = 'StalePackageError';
    this.affected = affected;
  }
}

/** 合并失败错误：原始记录已恢复 */
export class MergeFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MergeFailedError';
  }
}
