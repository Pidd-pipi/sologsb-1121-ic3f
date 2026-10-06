import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Empty,
  Input,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  Upload,
  type TableProps,
} from 'antd';
import {
  CloudDownloadOutlined,
  CloudUploadOutlined,
  FileDoneOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { usePlotStore } from '../stores/plotStore';
import { useTreeStore } from '../stores/treeStore';
import { useRegenStore } from '../stores/regenStore';
import {
  applyMerge,
  buildPackage,
  parsePackage,
  planMerge,
  recalcAfterMerge,
  type ExchangePackage,
  type FieldDiff,
  type MergedPlot,
  type PlotMergeReport,
  type TreeConflict,
  type RegenConflict,
} from '../utils/exchange';

const { Text, Paragraph } = Typography;

type Columns<T> = NonNullable<TableProps<T>['columns']>;

/** /exchange 离线合并：导出交换包、导入合并（单边直接并入、冲突保留本机、失败回滚、旧包失效） */
export default function Exchange() {
  const plots = usePlotStore((s) => s.items);
  const trees = useTreeStore((s) => s.items);
  const regens = useRegenStore((s) => s.items);
  const loadPlots = usePlotStore((s) => s.load);
  const loadTrees = useTreeStore((s) => s.load);
  const loadRegens = useRegenStore((s) => s.load);

  const [selected, setSelected] = useState<string[]>([]);
  const [source, setSource] = useState('');
  const [toast, setToast] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [pkg, setPkg] = useState<ExchangePackage | null>(null);
  const [plans, setPlans] = useState<MergedPlot[] | null>(null);
  const [reports, setReports] = useState<PlotMergeReport[] | null>(null);
  const [fileName, setFileName] = useState('');

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const sortedPlots = useMemo(() => [...plots].sort((a, b) => a.plotNo.localeCompare(b.plotNo)), [plots]);

  const treeCountOf = (plotId: string) => trees.filter((t) => t.plotId === plotId).length;
  const regenCountOf = (plotId: string) => regens.filter((r) => r.plotId === plotId).length;

  /* ---------------- 导出 ---------------- */
  const doExport = async () => {
    if (selected.length === 0) {
      setError('请先勾选要导出的样地');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const chosen = sortedPlots.filter((p) => selected.includes(p.id));
      const exchange = await buildPackage(chosen, { crew: source.trim() || undefined });
      const blob = new Blob([JSON.stringify(exchange, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp = new Date().toISOString().slice(0, 10);
      a.download = `森林样地交换包_${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setToast(`已导出 ${chosen.length} 个样地的交换包（含样地修订号与期次）`);
    } catch (e) {
      setError(`导出失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  /* ---------------- 导入：解析 + 预览 ---------------- */
  const onFile = async (file: File) => {
    setBusy(true);
    setError('');
    setReports(null);
    try {
      const text = await file.text();
      const parsed = parsePackage(text);
      const merged = planMerge(parsed, plots, trees, regens);
      setPkg(parsed);
      setPlans(merged);
      setFileName(file.name);
      const stale = merged.filter((m) => m.report.status === 'stale').length;
      if (stale > 0) {
        setError(`有 ${stale} 个样地的交换包修订号低于本机，已判定为旧包失效（见下方受影响对象）`);
      } else {
        setToast(`已读取交换包（${parsed.plots.length} 个样地），请核对合并预览`);
      }
    } catch (e) {
      setPkg(null);
      setPlans(null);
      setError(`交换包解析失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
    return false;
  };

  /* ---------------- 执行合并（事务，失败回滚） ---------------- */
  const doMerge = async () => {
    if (!plans) return;
    const actionable = plans.filter((m) => m.report.status !== 'stale');
    if (actionable.length === 0) {
      setError('没有可合并的样地（全部为旧包已失效）');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await applyMerge(plans);
      await recalcAfterMerge(plans);
      await Promise.all([loadPlots(), loadTrees(), loadRegens()]);
      setReports(plans.map((m) => m.report));
      const added = plans.reduce((s, m) => s + m.report.addedTrees.length + m.report.addedRegens.length, 0);
      const updated = plans.reduce((s, m) => s + m.report.updatedTrees.length + m.report.updatedRegens.length, 0);
      const conflicts = plans.reduce((s, m) => s + m.report.conflictTrees.length + m.report.conflictRegens.length, 0);
      setToast(`合并完成：并入 ${added} 条、更新 ${updated} 条、待核冲突 ${conflicts} 条（复查比对已重算）`);
      setPkg(null);
      setPlans(null);
    } catch (e) {
      // 事务已整体回滚，恢复原记录
      await Promise.all([loadPlots(), loadTrees(), loadRegens()]);
      setError(`合并失败，已恢复原记录：${e instanceof Error ? e.message : String(e)}`);
      setReports(null);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setPkg(null);
    setPlans(null);
    setReports(null);
    setFileName('');
    setError('');
  };

  const staleCount = plans?.filter((m) => m.report.status === 'stale').length ?? 0;
  const conflictCount =
    plans?.reduce((s, m) => s + m.report.conflictTrees.length + m.report.conflictRegens.length, 0) ?? 0;

  return (
    <Space direction="vertical" size={14} style={{ width: '100%' }}>
      <Space wrap align="center">
        <Typography.Title level={4} style={{ margin: 0 }}>
          离线合并 · 数据交换
        </Typography.Title>
        <Tag color="green">交换包写明样地修订号与期次</Tag>
        <Tag>单边新增/改过直接并入</Tag>
        <Tag color="orange">两边冲突保留本机、列出待核</Tag>
        <div style={{ flex: 1 }} />
        <Button type="link">
          <Link to="/plots">返回台账</Link>
        </Button>
      </Space>

      {toast ? <Alert type="success" showIcon message={toast} closable onClose={() => setToast('')} /> : null}
      {error ? <Alert type="error" showIcon message={error} closable onClose={() => setError('')} /> : null}

      <Row gutter={12}>
        {/* 导出 */}
        <Col span={12}>
          <Card
            size="small"
            title={
              <Space>
                <CloudDownloadOutlined /> 导出交换包
              </Space>
            }
          >
            <Paragraph type="secondary" style={{ marginBottom: 8 }}>
              勾选样地后导出 JSON 交换包。包含各样地当前数据、样地修订号与期次，以及最近同步基线，供另一台机器做三方合并。
            </Paragraph>
            <Space wrap style={{ marginBottom: 8 }}>
              <Input
                style={{ width: 220 }}
                placeholder="本机/调查组标识（可选）"
                value={source}
                onChange={(e) => setSource(e.target.value)}
              />
              <Button
                size="small"
                onClick={() =>
                  setSelected(
                    selected.length === sortedPlots.length ? [] : sortedPlots.map((p) => p.id),
                  )
                }
              >
                {selected.length === sortedPlots.length ? '全不选' : '全选'}
              </Button>
            </Space>
            <Checkbox.Group
              style={{ width: '100%' }}
              value={selected}
              onChange={(v) => setSelected(v as string[])}
              options={sortedPlots.map((p) => ({
                value: p.id,
                label: (
                  <span>
                    {p.plotNo}
                    <Tag style={{ marginLeft: 6 }}>v{p.revision}</Tag>
                    <Tag color="blue">第 {p.surveyRound} 期</Tag>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      样木 {treeCountOf(p.id)} · 更新苗 {regenCountOf(p.id)}
                    </Text>
                  </span>
                ),
              }))}
            />
            <div style={{ marginTop: 12 }}>
              <Button type="primary" icon={<CloudDownloadOutlined />} loading={busy} onClick={doExport}>
                生成交换包并下载
              </Button>
            </div>
          </Card>
        </Col>

        {/* 导入 */}
        <Col span={12}>
          <Card
            size="small"
            title={
              <Space>
                <CloudUploadOutlined /> 导入交换包合并
              </Space>
            }
          >
            <Paragraph type="secondary" style={{ marginBottom: 8 }}>
              选择另一台机器导出的交换包。系统按样地号匹配，单边新增/改过直接并入；同一树号两边都有新测量值时保留本机值并列出待核冲突；修订号低于本机的旧包立即失效。
            </Paragraph>
            <Upload
              accept="application/json,.json"
              showUploadList={false}
              beforeUpload={(file) => {
                void onFile(file);
                return false;
              }}
            >
              <Button icon={<CloudUploadOutlined />} loading={busy}>
                选择交换包文件
              </Button>
            </Upload>
            {fileName ? (
              <Tag color="blue" style={{ marginTop: 8 }}>
                <FileDoneOutlined /> {fileName}
              </Tag>
            ) : null}
            {pkg ? (
              <Descriptions size="small" column={2} style={{ marginTop: 8 }}>
                <Descriptions.Item label="导出时间">
                  {new Date(pkg.exportedAt).toLocaleString('zh-CN')}
                </Descriptions.Item>
                <Descriptions.Item label="来源">{pkg.source.crew || '未填写'}</Descriptions.Item>
                <Descriptions.Item label="样地数">{pkg.plots.length}</Descriptions.Item>
                <Descriptions.Item label="结构版本">v{pkg.version}</Descriptions.Item>
              </Descriptions>
            ) : null}
          </Card>
        </Col>
      </Row>

      {/* 合并预览 */}
      {plans && !reports ? (
        <Card
          size="small"
          title="合并预览"
          extra={
            <Space>
              {staleCount > 0 ? <Badge status="error" text={`${staleCount} 个旧包失效`} /> : null}
              {conflictCount > 0 ? <Badge status="warning" text={`${conflictCount} 条待核冲突`} /> : null}
              <Button onClick={reset}>取消</Button>
              <Button
                type="primary"
                danger={actionableHasConflict(plans)}
                icon={<FileDoneOutlined />}
                loading={busy}
                onClick={doMerge}
              >
                执行合并（失败自动回滚）
              </Button>
            </Space>
          }
        >
          {plans.map((m) => (
            <PlotPreview key={m.localPlotId} plan={m} />
          ))}
        </Card>
      ) : null}

      {/* 合并结果 */}
      {reports ? (
        <Card size="small" title="合并结果">
          {reports.map((r) => (
            <PlotReport key={r.plotId} report={r} />
          ))}
          <div style={{ marginTop: 12 }}>
            <Button onClick={reset}>继续交换</Button>
          </div>
        </Card>
      ) : null}

      {!plans && !reports ? (
        <Card size="small">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="导入交换包后显示合并预览；合并完成后复查比对与林分汇总将按新数据重算"
          />
        </Card>
      ) : null}
    </Space>
  );
}

function actionableHasConflict(plans: MergedPlot[]): boolean {
  return plans.some(
    (m) => m.report.status !== 'stale' && (m.report.conflictTrees.length > 0 || m.report.conflictRegens.length > 0),
  );
}

/* ---------------- 预览子组件 ---------------- */

function PlotPreview({ plan }: { plan: MergedPlot }) {
  const r = plan.report;
  const stale = r.status === 'stale';
  return (
    <Card
      size="small"
      type="inner"
      title={
        <Space>
          <Text strong>{r.plotNo}</Text>
          {plan.isNew ? <Tag color="green">新样地导入</Tag> : null}
          {stale ? <Tag color="red">旧包失效</Tag> : <Tag color="blue">可合并</Tag>}
          <Tag>本机 v{r.localRevision}</Tag>
          <Tag>包内 v{r.packageRevision}</Tag>
        </Space>
      }
      style={{ marginBottom: 10 }}
    >
      {stale ? (
        <Alert
          type="error"
          showIcon
          icon={<WarningOutlined />}
          message="交换包修订号低于本机，已判定为旧包并失效，本次不并入任何数据"
          description={
            <div>
              <div>受影响对象（共 {r.affected.length} 项）：</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {r.affected.map((a, i) => (
                  <li key={i}>{a.desc}</li>
                ))}
              </ul>
            </div>
          }
        />
      ) : (
        <>
          <Row gutter={8}>
            <Col span={6}>
              <Statistic title="并入样木" value={r.addedTrees.length} suffix="株" />
            </Col>
            <Col span={6}>
              <Statistic title="更新样木" value={r.updatedTrees.length} suffix="株" />
            </Col>
            <Col span={6}>
              <Statistic title="待核冲突（样木）" value={r.conflictTrees.length} suffix="株" />
            </Col>
            <Col span={6}>
              <Statistic title="更新苗/灌木" value={r.addedRegens.length + r.updatedRegens.length} suffix="条" />
            </Col>
          </Row>
          {r.updatedTrees.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <Text type="secondary">远端改过、直接并入：</Text>
              <div>
                {r.updatedTrees.map((t) => (
                  <Tag key={t.key} color="blue">
                    树号 {t.treeNo}（第{t.round}期）{t.changes.length ? `：${t.changes.join('；')}` : ''}
                  </Tag>
                ))}
              </div>
            </div>
          ) : null}
          {r.conflictTrees.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <Text type="warning">两边都有新测量值，保留本机、待核：</Text>
              {r.conflictTrees.map((c) => (
                <ConflictTreeTable key={c.key} conflict={c} />
              ))}
            </div>
          ) : null}
          {r.conflictRegens.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <Text type="warning">更新苗/灌木两边不一致，保留本机、待核：</Text>
              {r.conflictRegens.map((c) => (
                <ConflictRegenTable key={c.key} conflict={c} />
              ))}
            </div>
          ) : null}
          {r.notes.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <Text type="secondary">说明：</Text>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {r.notes.map((n, i) => (
                  <li key={i}>
                    <Text type="secondary">{n}</Text>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

function ConflictTreeTable({ conflict }: { conflict: TreeConflict }) {
  const columns: Columns<FieldDiff> = [
    { title: '字段', dataIndex: 'label', width: 110 },
    { title: '本机值（保留）', dataIndex: 'local', width: 140, render: (v: unknown) => String(v) },
    { title: '包内值（待核）', dataIndex: 'remote', width: 140, render: (v: unknown) => String(v) },
  ];
  return (
    <Card size="small" type="inner" style={{ marginTop: 6 }} title={`树号 ${conflict.treeNo}（第${conflict.round}期） · ${conflict.species}`}>
      <Table<FieldDiff>
        rowKey="field"
        size="small"
        columns={columns}
        dataSource={conflict.fieldDiffs}
        pagination={false}
      />
    </Card>
  );
}

function ConflictRegenTable({ conflict }: { conflict: RegenConflict }) {
  const columns: Columns<FieldDiff> = [
    { title: '字段', dataIndex: 'label', width: 110 },
    { title: '本机值（保留）', dataIndex: 'local', width: 140, render: (v: unknown) => String(v) },
    { title: '包内值（待核）', dataIndex: 'remote', width: 140, render: (v: unknown) => String(v) },
  ];
  return (
    <Card
      size="small"
      type="inner"
      style={{ marginTop: 6 }}
      title={`${conflict.layer} · ${conflict.species}（第${conflict.round}期）`}
    >
      <Table<FieldDiff>
        rowKey="field"
        size="small"
        columns={columns}
        dataSource={conflict.fieldDiffs}
        pagination={false}
      />
    </Card>
  );
}

/* ---------------- 结果子组件 ---------------- */

function PlotReport({ report }: { report: PlotMergeReport }) {
  const stale = report.status === 'stale';
  return (
    <Card
      size="small"
      type="inner"
      title={
        <Space>
          <Text strong>{report.plotNo}</Text>
          {stale ? <Tag color="red">旧包未合并</Tag> : <Tag color="green">已合并</Tag>}
          <Tag>本机 v{report.localRevision} → v{report.status === 'merged' ? report.localRevision + 1 : report.localRevision}</Tag>
        </Space>
      }
      style={{ marginBottom: 10 }}
    >
      {stale ? (
        <Alert type="warning" showIcon message="旧交换包已失效，未并入数据" />
      ) : (
        <Space wrap size={16}>
          <Statistic title="并入样木" value={report.addedTrees.length} suffix="株" />
          <Statistic title="更新样木" value={report.updatedTrees.length} suffix="株" />
          <Statistic title="待核冲突" value={report.conflictTrees.length + report.conflictRegens.length} suffix="条" />
          <Statistic title="并入更新苗/灌木" value={report.addedRegens.length + report.updatedRegens.length} suffix="条" />
        </Space>
      )}
      {report.conflictTrees.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          <Text type="warning">待核冲突（保留本机值）：</Text>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {report.conflictTrees.map((c) => (
              <li key={c.key}>
                树号 {c.treeNo}（第{c.round}期）{c.species}：
                {c.fieldDiffs.map((d) => `${d.label} 本机=${String(d.local)} / 包内=${String(d.remote)}`).join('；')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {report.conflictRegens.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          <Text type="warning">待核冲突（保留本机值）：</Text>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {report.conflictRegens.map((c) => (
              <li key={c.key}>
                {c.layer} {c.species}（第{c.round}期）：
                {c.fieldDiffs.map((d) => `${d.label} 本机=${String(d.local)} / 包内=${String(d.remote)}`).join('；')}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {report.notes.length > 0 ? (
        <div style={{ marginTop: 8 }}>
          {report.notes.map((n, i) => (
            <Tag key={i} style={{ marginBottom: 4 }}>
              {n}
            </Tag>
          ))}
        </div>
      ) : null}
    </Card>
  );
}
