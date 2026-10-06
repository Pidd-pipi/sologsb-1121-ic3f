# sologsb-1121 森林样地调查记录台（gbforestplot）

面向森林资源调查员的固定样地工作台：为样地建档，逐株记录胸径、树高、枝下高与检尺位置，登记更新幼苗与灌木层，并在复查期与上一期数据逐株比对生长量、计算林分因子。多台笔记本离线外业后，通过交换包做离线合并，不再整包覆盖。纯前端单页应用，数据全部保存在浏览器本地。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

访问地址：**http://localhost:21821**

停止服务：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| UI | Ant Design 5 |
| 构建 | Vite 5 |
| 状态管理 | Zustand |
| 路由 | React Router v6（BrowserRouter） |
| 本地存储 | IndexedDB（Dexie 4），含结构版本号与升级迁移 |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:5173
npm run build    # tsc 类型检查 + vite 构建
npm test         # vitest：离线合并引擎单元测试（fake-indexeddb）
```

> 生产环境由 nginx 托管 `dist`，`nginx.conf` 已启用 `try_files $uri $uri/ /index.html;` 与 gzip。

## 目录结构

```
sologsb-1121/
├── docker-compose.yml
├── .env.example
├── .env
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf
    ├── index.html
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── main.tsx
        ├── index.css
        ├── router/index.tsx
        ├── types/{plot,tree,regen,recheck,sync}.ts
        ├── stores/{plot,tree,regen}Store.ts
        ├── components/common/{PlotCard,TreeTable,GrowthDiffTable,RoundTag}.tsx
        ├── hooks/{usePlotFilter,useTreeStats}.ts
        ├── pages/{PlotList,TreeEntry,RegenView,RecheckView,PlotSummary,SyncCenter}.tsx
        └── utils/{db,forestCalc,id,merge,recheck}.ts、utils/merge.test.ts
```

## 页面与路由

| 路由 | 页面 | 消费模型 |
| --- | --- | --- |
| `/plots` | 样地台账：按地点/林型/复查期次/郁闭度区间筛选，显示面积、优势树种、已录样木数，可锁定往期 | Plot |
| `/plots/:id/trees` | 样木录入与清单：径阶分组快速录入、行内改胸径、树种联想、胸径异常提示 | TreeRecord |
| `/plots/:id/regen` | 更新苗与灌木样方记录，按高度级与株数分组合计 | RegenShrub |
| `/plots/:id/recheck` | 复查比对：逐株两期胸径/树高与生长量，标记缺失与状态变化，保存比对结果 | RecheckDiff、TreeRecord |
| `/summary/:plotId` | 林分因子汇总：每公顷株数、平均胸径、断面积、郁闭度、更新密度，可导出调查记录文本 | Plot、TreeRecord、RegenShrub |
| `/sync` | 离线合并：导出/导入交换包、待核冲突处理、合并日志 | ExchangePackage、MergeConflict、MergeLog |

`/` 重定向到 `/plots`，未匹配路由同样兜底到 `/plots`。

## 数据存储说明

- 数据库名 `gbforestplot`，当前结构版本 **v3**（`localStorage['gbforestplot:db-version']` 记录）。
- 七张表：`plots`（样地）、`trees`（样木，按期次分行）、`regens`（更新苗与灌木样方）、`rechecks`（复查逐株比对）、`merges`（合并日志）、`conflicts`（待核冲突）、`deletions`（删除墓碑）。
- v1 → v2 迁移：为老样地补 `locked`、`surveyRound`，为老样木补 `round`、`measuredAt`，并新增索引。
- v2 → v3 迁移（旧数据按新结构升级）：样地补 `revision`/`syncedRevision`/`updatedAt`，样木与更新苗补 `rev`/`updatedAt`，新建合并日志、待核冲突与删除墓碑三张表。
- 容器无状态、不挂载命名卷；清空站点数据即回到初始示范数据。
- 首次打开灌入 2 个示范样地、11 条样木（含第 1/2 两期，便于直接做复查比对）与 4 条样方记录。

## 离线合并（多机外业 → 回来后合并）

多台笔记本各自离线记录同一批样地，回来后用交换包（JSON 文件）两两合并，替代原来的整包覆盖：

- **交换包**：写明样地修订号（`plotRevision`）、基准修订号（`baseRevision`）与期次（`round`），携带样地全量样木与更新苗；导出即推进本机同步点。
- **修订号**：样地每次本机改动（增删改样木/更新苗/样地字段）`revision` +1，记录带 `rev` 标记最后改动时的修订号。
- **合并规则**（按业务键逐记录判定：样木=树号+期次，更新苗=层位+树种+期次）：
  - 单边新增或单边改过的记录直接并入；
  - 同一树号两边都有新测量值时**保留本机值**，并登记为待核冲突（可在 `/sync` 页逐条「采用对方值」或「保持本机」）；
  - 本机已删除的记录登记墓碑，不会被对方包里的旧记录复活。
- **失败恢复**：合并前先快照，事务内应用；任一环节失败即回滚并恢复原记录，日志记「失败已恢复」。
- **旧包失效**：本机修订号更新后，修订号更旧的交换包立即失效，拒绝导入并列出受影响对象（样地字段/树号/更新苗及与本机的差异）；同一包重复导入同样被拒。
- **合并后重算**：复查比对按合并后数据重算最新两期并整批替换存档；林分汇总随 store 重载自动重算，合并报告附重算后的每公顷株数、平均胸径、断面积与更新密度。
- **旧包升级**：缺少 `rev`/修订号字段的旧交换包按新结构补齐默认值后可正常合并。

## 功能要点

- **径阶归组**：按「6/8/12/16/20/24/28/32+」cm 径阶自动归组，表格内联展示各径阶株数。
- **胸径异常提示**：数值超出 0~200 cm 或与本树种同期均值偏离 >60% 时标黄并给出提示。
- **复查比对**：任选上下两期生成逐株差值表，标记「本期未复测（疑似采伐或倒伏）」与「本期新增进界木」，生长率为负或缺失行高亮，并计算保留木生长率。
- **林分因子**：每公顷株数、平均胸径/树高、断面积与每公顷断面积、冠幅折算郁闭度、更新苗/灌木密度。
- **导出**：复查比对结果写入本地档案库；林分汇总可复制或导出调查记录 txt。
