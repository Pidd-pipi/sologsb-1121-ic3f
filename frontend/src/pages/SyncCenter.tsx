import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  type TableProps,
} from 'antd';
import { DownloadOutlined, MergeCellsOutlined, UploadOutlined } from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useTreeStore } from '../stores/treeStore';
import { useRegenStore } from '../stores/regenStore';
import { db } from '../utils/db';
import {
  applyMerge,
  exportPlotPackage,
  listConflicts,
  listMergeLogs,
  logRejectedPackage,
  normalizePackage,
  previewMerge,
  resolveConflict,
} from '../utils/merge';
import {
  MergeFailedError,
  StalePackageError,
  type AffectedObject,
  type ExchangePackage,
  type MergeConflict,
  type MergeLog,
  type MergePreview,
  type MergeReport,
} from '../types/sync';
import type { Plot } from '../types/plot';

const DEVICE_KEY = 'gbforestplot:device';

/** 冲突值里重点展示的字段 */
const FIELD_LABELS: Record<string, string> = {
  dbhCm: '胸径cm',
  heightM: '树高m',
  underBranchH: '枝下高m',
  crownWidth: '冠幅m',
  status: '状态',
  healthClass: '健康',
  tiltDeg: '倾斜°',
  remark: '备注',
  count: '株数',
  heightCm: '高度cm',
  ageGroup: '龄组',
  distribution: '分布',
  browseDamage: '危害',
  locality: '地点',
  area: '面积m²',
  elevation: '海拔m',
  slope: '坡度°',
  aspect: '坡向',
  forestType: '林型',
  canopyDensity: '郁闭度',
  dominantSpecies: '优势树种',
  crew: '调查组',
  plotNo: '样地号',
};

function fmtValues(values: Record<string, string | number | undefined>): string {
  const parts = Object.entries(FIELD_LABELS)
    .filter(([k]) => values[k] !== undefined)
    .map(([k, label]) => `${label} ${values[k]}`);
  return parts.length > 0 ? parts.join('，') : '—';
}

function download(pkg: ExchangePackage): void {
  const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `交换包_${pkg.plotNo}_r${pkg.plotRevision}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/** /sync 离线合并中心：交换包导出/导入、待核冲突、合并日志 */
export default function SyncCenter() {
  const loadPlots = usePlotStore((s) => s.load);
  const loadTrees = useTreeStore((s) => s.load);
  const loadRegens = useRegenStore((s) => s.load);

  const [plots, setPlots] = useState<Plot[]>([]);
  const [plotId, setPlotId] = useState('');
  const [device, setDevice] = useState(() => {
    try {
      return window.localStorage.getItem(DEVICE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [pending, setPending] = useState<{ pkg: ExchangePackage; preview: MergePreview } | null>(null);
  const [stale, setStale] = useState<{ message: string; affected: AffectedObject[] } | null>(null);
  const [report, setReport] = useState<MergeReport | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [conflicts, setConflicts] = useState<MergeConflict[]>([]);
  const [logs, setLogs] = useState<MergeLog[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    const [plotRows, conflictRows, logRows] = await Promise.all([
      db.plots.toArray(),
      listConflicts(),
      listMergeLogs(),
    ]);
    plotRows.sort((a, b) => a.plotNo.localeCompare(b.plotNo));
    setPlots(plotRows);
    setConflicts(conflictRows);
    setLogs(logRows);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const selected = plots.find((p) => p.id === plotId);

  const doExport = async () => {
    if (!plotId) {
      setError('请先选择要导出的样地');
      return;
    }
    setBusy(true);
    try {
      const pkg = await exportPlotPackage(plotId, device.trim() || '未命名设备');
      download(pkg);
      setToast(`已导出「${pkg.plotNo}」交换包（修订号 r${pkg.plotRevision}，第 ${pkg.round} 期）`);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File) => {
    setError('');
    setStale(null);
    setReport(null);
    let pkg: ExchangePackage;
    try {
      pkg = normalizePackage(JSON.parse(await file.text()));
    } catch (err) {
      setError(`交换包无法识别：${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    try {
      const preview = await previewMerge(pkg);
      setPending({ pkg, preview });
    } catch (err) {
      if (err instanceof StalePackageError) {
        setStale({ message: err.message, affected: err.affected });
        await logRejectedPackage(pkg, err.message);
        await reload();
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const doMerge = async () => {
    if (!pending) return;
    setBusy(true);
    setError('');
    try {
      const result = await applyMerge(pending.pkg);
      setReport(result);
      setPending(null);
      await reload();
      // 合并后各页面的复查比对与林分汇总依赖 store 数据，重载触发重算
      await Promise.all([loadPlots(), loadTrees(), loadRegens()]);
    } catch (err) {
      setPending(null);
      if (err instanceof MergeFailedError) {
        setError(err.message);
      } else if (err instanceof StalePackageError) {
        setStale({ message: err.message, affected: err.affected });
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const doResolve = async (conflictId: string, choice: 'remote' | 'local') => {
    await resolveConflict(conflictId, choice);
    await reload();
    await Promise.all([loadPlots(), loadTrees(), loadRegens()]);
    setToast(choice === 'remote' ? '已采用对方值（本机修订号已更新）' : '已保持本机值');
  };

  const affectedColumns: NonNullable<TableProps<AffectedObject>['columns']> = [
    { title: '类型', dataIndex: 'kind', width: 90, render: (v: string) => <Tag color="orange">{v}</Tag> },
    { title: '对象', dataIndex: 'key', width: 220 },
    { title: '与本机差异', dataIndex: 'detail' },
  ];

  const conflictColumns: NonNullable<TableProps<MergeConflict>['columns']> = [
    {
      title: '样地',
      width: 100,
      render: (_: unknown, c) => plots.find((p) => p.id === c.plotId)?.plotNo ?? c.plotId,
    },
    { title: '类型', dataIndex: 'kind', width: 80 },
    {
      title: '对象',
      width: 150,
      render: (_: unknown, c) =>
        c.kind === '样地' ? '样地描述' : `${c.treeNo}（第 ${c.round} 期）`,
    },
    {
      title: '本机值（已保留）',
      render: (_: unknown, c) => <Typography.Text>{fmtValues(c.localValues)}</Typography.Text>,
    },
    {
      title: '对方值',
      render: (_: unknown, c) => <Typography.Text type="warning">{fmtValues(c.remoteValues)}</Typography.Text>,
    },
    { title: '来源设备', dataIndex: 'device', width: 110 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (v: MergeConflict['status']) => (
        <Tag color={v === '待核' ? 'red' : v === '已采用对方' ? 'blue' : 'default'}>{v}</Tag>
      ),
    },
    {
      title: '操作',
      width: 190,
      render: (_: unknown, c) =>
        c.status === '待核' ? (
          <Space size={4}>
            <Button size="small" onClick={() => void doResolve(c.id, 'remote')}>
              采用对方值
            </Button>
            <Button size="small" onClick={() => void doResolve(c.id, 'local')}>
              保持本机
            </Button>
          </Space>
        ) : null,
    },
  ];

  const logColumns: NonNullable<TableProps<MergeLog>['columns']> = [
    {
      title: '时间',
      dataIndex: 'at',
      width: 160,
      render: (v: number) => new Date(v).toLocaleString('zh-CN'),
    },
    { title: '样地', dataIndex: 'plotNo', width: 100 },
    { title: '对方设备', dataIndex: 'device', width: 120 },
    {
      title: '并入',
      width: 150,
      render: (_: unknown, l) => `新增 ${l.added} / 更新 ${l.updated} / 冲突 ${l.conflictCount}`,
    },
    {
      title: '修订号',
      width: 120,
      render: (_: unknown, l) => (l.fromRevision === l.toRevision ? `r${l.toRevision}` : `r${l.fromRevision} → r${l.toRevision}`),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (v: MergeLog['status']) => (
        <Tag color={v === '成功' ? 'green' : v === '失败已恢复' ? 'volcano' : 'orange'}>{v}</Tag>
      ),
    },
    { title: '说明', dataIndex: 'message' },
  ];

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          离线合并
        </Typography.Title>
        <Tag>交换包携带样地修订号与期次</Tag>
        <div style={{ flex: 1 }} />
        <span>
          本机设备名{' '}
          <Input
            style={{ width: 160 }}
            placeholder="如 外业-01"
            value={device}
            onChange={(e) => {
              setDevice(e.target.value);
              try {
                window.localStorage.setItem(DEVICE_KEY, e.target.value);
              } catch {
                /* 忽略 */
              }
            }}
          />
        </span>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}
      {stale ? (
        <Alert
          type="warning"
          showIcon
          closable
          onClose={() => setStale(null)}
          message="旧交换包已失效，拒绝导入"
          description={
            <>
              <div style={{ marginBottom: 8 }}>{stale.message}</div>
              {stale.affected.length > 0 ? (
                <Table<AffectedObject>
                  rowKey={(r) => `${r.kind}:${r.key}`}
                  size="small"
                  columns={affectedColumns}
                  dataSource={stale.affected}
                  pagination={false}
                />
              ) : (
                <div>包内数据与本机当前状态一致，无需合并。</div>
              )}
            </>
          }
        />
      ) : null}

      {report ? (
        <Alert
          type="success"
          showIcon
          closable
          onClose={() => setReport(null)}
          message={`合并完成：「${report.plotNo}」修订号 r${report.fromRevision || '-'} → r${report.newRevision}`}
          description={
            <Space direction="vertical" size={4}>
              <div>
                新增并入 {report.added} 条，更新并入 {report.updated} 条，一致跳过 {report.skipped} 条，
                本机已删保留 {report.tombstoned} 条，待核冲突 {report.conflicts.length} 条（保留本机值）。
              </div>
              <div>
                {report.recheckRegenerated ? '复查比对已按合并后数据重算并写回档案。' : '样地不足两期数据，复查比对已清空。'}
                林分汇总已重算：每公顷 {report.stand.perHa} 株，平均胸径 {report.stand.meanDbh} cm，平均树高{' '}
                {report.stand.meanHeight} m，每公顷断面积 {report.stand.basalAreaPerHa} m²，更新苗{' '}
                {report.stand.regenPerHa} 株/hm²，灌木 {report.stand.shrubPerHa} 株/hm²。
              </div>
              <div>
                <Link to={`/plots/${report.plotId}/recheck`}>查看复查比对</Link>
                {' · '}
                <Link to={`/summary/${report.plotId}`}>查看林分汇总</Link>
              </div>
            </Space>
          }
        />
      ) : null}

      <Row gutter={12}>
        <Col span={12}>
          <Card size="small" title="导出交换包（发给其他外业机）">
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Select
                style={{ width: '100%' }}
                placeholder="选择样地"
                value={plotId || undefined}
                onChange={setPlotId}
                options={plots.map((p) => ({
                  value: p.id,
                  label: `${p.plotNo} · ${p.locality}（修订号 r${p.revision}，第 ${p.surveyRound} 期）`,
                }))}
              />
              {selected ? (
                <Descriptions size="small" column={3}>
                  <Descriptions.Item label="样地修订号">r{selected.revision}</Descriptions.Item>
                  <Descriptions.Item label="同步点">r{selected.syncedRevision}</Descriptions.Item>
                  <Descriptions.Item label="期次">第 {selected.surveyRound} 期</Descriptions.Item>
                </Descriptions>
              ) : null}
              <Button type="primary" icon={<DownloadOutlined />} loading={busy} onClick={() => void doExport()}>
                导出交换包
              </Button>
            </Space>
          </Card>
        </Col>
        <Col span={12}>
          <Card size="small" title="导入交换包（离线合并到本机）">
            <Space direction="vertical" size={10} style={{ width: '100%' }}>
              <Typography.Text type="secondary">
                单边新增或修改的记录直接并入；同一树号两边都有新测量值时保留本机值并列入待核冲突；合并失败自动恢复原记录。
              </Typography.Text>
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void onFile(file);
                  e.target.value = '';
                }}
              />
              <Button icon={<UploadOutlined />} loading={busy} onClick={() => fileRef.current?.click()}>
                选择交换包文件…
              </Button>
            </Space>
          </Card>
        </Col>
      </Row>

      <Card
        size="small"
        title={`待核冲突（${conflicts.filter((c) => c.status === '待核').length} 条待核）`}
      >
        <Table<MergeConflict>
          rowKey="id"
          size="small"
          columns={conflictColumns}
          dataSource={conflicts}
          pagination={{ pageSize: 8, hideOnSinglePage: true }}
          locale={{ emptyText: '暂无冲突，合并时两边都改过的记录会列在这里' }}
        />
      </Card>

      <Card size="small" title="合并日志">
        <Table<MergeLog>
          rowKey="id"
          size="small"
          columns={logColumns}
          dataSource={logs}
          pagination={{ pageSize: 8, hideOnSinglePage: true }}
          locale={{ emptyText: '暂无合并记录' }}
        />
      </Card>

      <Modal
        open={pending !== null}
        title={
          <Space>
            <MergeCellsOutlined />
            确认合并交换包
          </Space>
        }
        okText="确认合并"
        cancelText="取消"
        confirmLoading={busy}
        onOk={() => void doMerge()}
        onCancel={() => setPending(null)}
      >
        {pending ? (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="样地">{pending.pkg.plotNo}</Descriptions.Item>
              <Descriptions.Item label="期次">第 {pending.pkg.round} 期</Descriptions.Item>
              <Descriptions.Item label="包内修订号">r{pending.pkg.plotRevision}</Descriptions.Item>
              <Descriptions.Item label="基准修订号">r{pending.pkg.baseRevision}</Descriptions.Item>
              <Descriptions.Item label="导出设备">{pending.pkg.device}</Descriptions.Item>
              <Descriptions.Item label="导出时间">
                {new Date(pending.pkg.exportedAt).toLocaleString('zh-CN')}
              </Descriptions.Item>
            </Descriptions>
            <Row gutter={8}>
              <Col span={8}>
                <Statistic title="新增并入" value={pending.preview.added} suffix="条" />
              </Col>
              <Col span={8}>
                <Statistic title="更新并入" value={pending.preview.updated} suffix="条" />
              </Col>
              <Col span={8}>
                <Statistic
                  title="待核冲突"
                  value={pending.preview.conflictCount}
                  suffix="条"
                  valueStyle={pending.preview.conflictCount > 0 ? { color: '#cf1322' } : undefined}
                />
              </Col>
            </Row>
            {pending.preview.isNewPlot ? (
              <Alert type="info" showIcon message="本机尚无该样地，将整包导入为新样地。" />
            ) : null}
            {pending.preview.tombstoned > 0 ? (
              <Alert
                type="info"
                showIcon
                message={`${pending.preview.tombstoned} 条记录本机已删除，合并时不会复活。`}
              />
            ) : null}
            {pending.preview.conflictCount > 0 ? (
              <Alert
                type="warning"
                showIcon
                message={`${pending.preview.conflictCount} 条记录两边都有新值，将保留本机值并列入待核冲突。`}
              />
            ) : null}
          </Space>
        ) : null}
      </Modal>
    </Space>
  );
}
