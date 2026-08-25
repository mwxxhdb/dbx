# 定制清单

本仓库是 `t8y2/dbx` 的 fork，做了个人化定制，同时保持能持续合并上游更新。

**给 AI Agent：合并上游冲突前先读完本文件。** 每条定制记录了改动位置、意图，以及上游若重写了那块代码该怎么办。

## 分支与同步

```
upstream  = https://github.com/t8y2/dbx.git   只读
origin    = git@github.com:mwxxhdb/dbx.git    fork

upstream-main   纯镜像分支，只做 fast-forward，永不提交自己的东西
main            定制分支
```

同步脚本与部署清单不在本仓库——它们含公司内部信息，放在一个私有仓库里，本地检出到
未跟踪的 `custom/`（已在 `.gitignore` 中）。下文提到「同步脚本」时指的是那份。

已启用 `rerere.enabled`——同一处冲突解决过一次后自动复用。

## 定制原则

1. 定制改动尽量以新增文件形式存在
2. 必须改上游文件时只留最小 hook，真正的逻辑放新文件
3. 每处侵入用 `// dbx-custom:start(<标签>)` / `// dbx-custom:end` 包裹
4. 每处侵入在本文件登记

## 定制产物（新增文件，永不冲突）

| 路径 | 用途 |
|---|---|
| `CUSTOMIZATIONS.md` | 本文件 |

设计文档、实现计划、上游同步脚本、镜像构建脚本与部署清单都在私有仓库，不在这里。

**下面这五个文件同样是新增文件、永不冲突，但物理位置在上游目录内，容易被误认成
上游代码**（详情见下方 `mongo-quick-open` 一节）：

| 路径 | 用途 |
|---|---|
| `apps/desktop/src/composables/useMongoQuickOpenSource.ts` | mongo quick-open「搜得到」的真正逻辑 |
| `apps/desktop/src/lib/app/mongoQuickOpenNavigation.ts` | mongo quick-open「打得开」的真正逻辑 |
| `apps/desktop/src/composables/__tests__/useMongoQuickOpenSource.spec.ts` | 上面第一个文件的测试 |
| `apps/desktop/src/composables/__tests__/useQuickOpen.mongoWiring.spec.ts` | `useQuickOpen.ts` 侵入点的接线测试 |
| `apps/desktop/src/lib/app/__tests__/mongoQuickOpenNavigation.spec.ts` | 上面第二个文件的测试，外加 App.vue 侵入点的源码文本探针 |

## 侵入上游文件的改动

（随实现进度登记，每完成一个 Task 追加一条）

### env-connections

| 文件 | 改动 |
|---|---|
| `crates/dbx-web/Cargo.toml` | dependencies 末尾加 `url` 和 `percent-encoding` |
| `crates/dbx-web/src/main.rs` | 顶部 `mod env_connections;`；storage 初始化后调用 `apply_env_connections` |
| `Cargo.lock` | 随上面两个新依赖自动新增 `percent-encoding` 和 `url` 两条 lock 记录（2 行 diff）。这是唯一一个不能用 `dbx-custom:start/end` 标记的侵入文件，在此显式登记。 |

**`Cargo.lock` 冲突是例外**：它不受下面「解冲突原则」里「冲突出现在其他文件 → 上游动了我们依赖的东西」这条规则约束——lockfile 冲突是常规现象，删掉冲突标记跑一次 `cargo build` 让它重新生成即可，不代表上游动了什么。

**意图**：通过 `DBX_CONN_*` 环境变量声明数据源，每次启动完全覆盖 id 以 `env-` 开头的连接，手动建的连接不受影响。

**真正的逻辑在** `crates/dbx-web/src/env_connections.rs`（新增文件，不会冲突）。

**上游重写 main.rs 时怎么办**：找到 `Storage::open` 之后、`AppState::new_*` 之前的位置，把那段 `match env_connections::apply_env_connections(...)` 重新插进去即可。唯一要求是 storage 已经初始化完毕。

**上游改了 ConnectionConfig 时怎么办**：大概率不用动。`env_connections.rs` 用 `serde_json::from_value` 构造，只提供无 serde default 的字段（id/name/db_type/host/port/username/password/database）。只有当上游给这几个字段之一改名，或新增一个没有 default 的必填字段时才会失败——那时 `parse_env_connection` 的单测会直接报出来。

### mongo-quick-open

| 文件 | 改动 |
|---|---|
| `apps/desktop/src/composables/useQuickOpen.ts` | 5 处，共 14 行新增 + 1 行删除：import、实例化 `mongoSource`、watch 里 `reset()`、watch 里 `search()`（各自 `start/end` 包裹，3 行一组）、`filteredItems` 里并入 `mongoSource.items.value`（单行标记，没有 `start/end`，因为改的是已有那一行，1 行新增替换 1 行删除，而不是新增一整行） |
| `apps/desktop/src/App.vue` | 2 处，共 7 行新增：import 的 `start/end` 三行块、`handleQuickOpenSelect` 里在「Navigate based on type」之前调 `openMongoQuickOpenTarget` 的 `start/end` 三行块，加上两块之间的一行空行 |

**意图**：让全局快速打开能搜到 MongoDB 的 database 和 collection，不必先在侧边栏展开，并且选中之后能正确打开。

**「搜得到」和「打得开」是两条独立路径**，两个文件各管一条，改任何一条都要同时验另一条：
- 搜得到 → `useQuickOpen.ts` + `useMongoQuickOpenSource.ts`
- 打得开 → `App.vue` + `lib/app/mongoQuickOpenNavigation.ts`

**为什么不能直接从 `REMOTE_SEARCH_UNSUPPORTED_TYPES` 里删掉 `mongodb`**：删了之后 mongodb 会走 `listCompletionTableMetadata`，那是 SQL 元数据路径，对 MongoDB 不适用。必须走 `mongo/list_databases` 和 `mongo/list_collections`。

**真正的逻辑在** `apps/desktop/src/composables/useMongoQuickOpenSource.ts` 和 `apps/desktop/src/lib/app/mongoQuickOpenNavigation.ts`（都是新增文件，不会冲突）。

**为什么 collection 的 `type` 是 `table`**：只为了让它走上游的匹配与去重逻辑。**不代表能复用上游的打开逻辑**——`openTableTarget()` 没有 mongodb 分支，会生成 `SELECT * FROM ...` 的 data tab。打开必须走 `openMongoQuickOpenTarget`。

**上游重构 useQuickOpen.ts 时怎么办**：这是本仓库风险最高的侵入点。重新挂接需要满足四件事：
1. `useMongoQuickOpenSource()` 在 composable 内实例化一次
2. 搜索输入变化时调 `reset()`，再对非空查询调 `search(query)`
3. `mongoSource.items.value` 并入参与匹配的候选项数组
4. 并入位置在去重（`quickOpenItemKey` + `seen`）之前，避免与侧边栏树节点重复

如果上游把候选项聚合改成了别的结构，照这四条重新接一遍即可，`useMongoQuickOpenSource.ts` 本身不需要改。

接完之后跑 `pnpm vitest run apps/desktop/src/composables/__tests__/useQuickOpen.mongoWiring.spec.ts`。

**注意：该 spec 内部用的是它自己的 `Contract 1/2/3/4` 编号，和上面这四条的编号不是同一套，不要互相当成对照表。** 对照关系：
- spec 的 Contract 1（search 结果并入 `filteredItems`）覆盖上面第 2 条（search 半边）和第 3 条（合并）
- spec 的 Contract 2、3 是对上面第 2 条里 search 门槛与调用顺序的细化
- spec 的 Contract 4（`reset()` 必须在每次按键时跑）覆盖的是上面**第 2 条**（不是它自己的编号 4）
- 上面第 1 条（`useMongoQuickOpenSource()` 只实例化一次）没有专门的断言，靠其他测试间接跑通
- 上面**第 4 条（并入位置在去重之前）没有任何测试**：mongo 树节点还不产出快速打开候选项（`processDatabaseTreeNodes` 没有 `mongo-db` / `mongo-collection` 分支），今天写这条测试只能造一个现实中不存在的碰撞，属于表演性测试。等上游让 mongo 树节点参与快速打开时再补。

该 spec 还带一条**静默腐烂探针**：断言 mongodb 连接永远不会走 `listCompletionTables`。上游若把 `mongodb` 从 `REMOTE_SEARCH_UNSUPPORTED_TYPES` 里删掉，mongo 会同时走 SQL 补全路径和本仓库的专用 source，产生重复且部分损坏的候选项——而那种改动既不产生合并冲突，也不会让其他任何测试变红。探针变红时怎么处理写在测试注释里。

**上游重构 App.vue 的 handleQuickOpenSelect 时怎么办**：找到「按 type 分发」的位置（`if (item.type === "connection")` 那一串之前，且在 `ensureConnected` 之后），把 `if (await openMongoQuickOpenTarget(item, connectionStore, queryStore)) return;` 重新插进去即可。它自己会判断连接是不是 mongodb，不是就返回 false 让上游逻辑继续。跑 `pnpm vitest run apps/desktop/src/lib/app/__tests__/mongoQuickOpenNavigation.spec.ts` 验证——这个 spec 除了验证 `openMongoQuickOpenTarget` 模块本身，还带一条 `describe("App.vue wiring (source-text probe)")` 的源码文本探针，断言 App.vue 里确实在 `ensureConnected` 之后、按 type 分发之前调用了它。**只验证模块不够**：模块测试从不 import App.vue，App.vue 完全不调用它模块测试也全绿——这也是为什么之前这条指引指向模块测试是一句没有意义的话，现在指向的是同一个文件里那条探针。

**`mongoQuickOpenNavigation.spec.ts` 会被上游给 connectionStore 加方法而打红。** 它用一个
手写的 stub 整个替换掉 `useConnectionStore`，而被测路径会调 `queryStore.setTableMeta()`——
上游往那里加的任何一个新的 store 调用，在这个 stub 上都是 `undefined`，测试直接抛
`TypeError: ... is not a function`。2026-08-25 那次同步就撞上了：上游加了
`metadataGenerationFor()`（issue #6623 / PR #6640），三个用例全红。**这不是回归，是 stub
缺字段**——照着报错点找到上游新调的那个方法，在 `mocks.connectionStore` 里补一个
`vi.fn()` 即可，上游自己的 spec（如 `useNavigationTargets.store.spec.ts`）就是这么写的。
补之前先确认那个方法在 `connectionStore` 里真实存在，别把上游的真 bug 当成 stub 缺字段掩盖掉。

**上游若给 MongoDB 加了原生快速打开支持**：直接删掉这两个文件里的全部侵入，以及 `useMongoQuickOpenSource.ts` 和 `mongoQuickOpenNavigation.ts`，改用上游实现。

### no-java

| 文件 | 改动 |
|---|---|
| `deploy/Dockerfile` | 2 处，均为**删除**：运行时阶段 apt 列表里的 `openjdk-17-jre-headless`；`ENV DBX_JAVA_BIN=/usr/bin/java` |

**这是本仓库唯一一个「反向 diff」型侵入点**，其余侵入点都是新增。它的 `dbx-custom:start/end` 块里没有生效代码，只有说明上游原本有什么、为什么删掉的注释。合并冲突时的判断方式也因此不同：**上游若在这两处附近改动，git 大概率不会报冲突，而是直接把上游的 openjdk 行合并回来**。**同步脚本在每次干净合并之后会自动跑这个检查**（连同全部登记侵入点的 marker 数量检查），合并失败会直接 `exit 1` 并打出修复提示，不需要再记得手动跑；手动复核时同样可以跑：

```bash
grep -n 'openjdk\|DBX_JAVA_BIN' deploy/Dockerfile | grep -v ':#'
```

有输出就说明 Java 被上游合回来了，重新删掉即可。

**意图**：目标部署只用 postgres 与 mongodb 两类连接，二者都走原生 Rust 驱动，JVM 从不被拉起，JRE 是纯死重。

**为什么两处必须一起删**：`external_driver_runtime_env`（`crates/dbx-core/src/connection.rs:1246`）在 `Managed` 模式且 JRE 未安装时返回空 `PluginRuntimeEnv`，agent 驱动子进程会继承镜像里的 `DBX_JAVA_BIN`，去 exec 一个不存在的 `/usr/bin/java`。只删 JRE 不删变量，错误信息会非常难定位。

**为什么 mongodb 不需要 JVM**：manifest 里 `mongodb` 的 `runtimeMode` 是 `agent`，容易误读。实际分发在 `crates/dbx-core/src/connection.rs:1890`：默认走原生 Rust 驱动（`mongodb` crate 3.8.0，`PoolKind::MongoDb`），只有 `mongo_uses_legacy_driver`（`agent_connection.rs:268`，只看 `driver_profile` 一个字段，而 `env_connections.rs` 从不设置它）为真、或原生失败且命中 `should_retry_mongo_with_legacy_driver`（`agent_connection.rs:276`，wire version 过旧或握手期 I/O 错误）时才用 agent。`runtimeMode` 字段在 Rust 侧从未被读取。

**影响面**：失去 `JavaRuntimeMode::System` 兜底。默认的 `Managed` 模式仍会自行下载 JRE 21（registry 中 45 个 agent 驱动均要求 `"jre": "21"`，被删的 17 本就不满足），有网即可用，无网则干净地失败。**若日后要在此镜像里连 Oracle / DB2 / SAP HANA 等 agent 驱动数据库，需要把这两行加回来，或确保 Pod 能访问 GitHub Releases。**

**不能一起删的包**：`fontconfig`、`fonts-dejavu-core`、`libfreetype6`。`system-fonts` 是 dbx-web 的默认 feature（`crates/dbx-web/Cargo.toml:12`），二进制链接了 `font-kit`。`ca-certificates`、`libssl3` 同样保留。

### china-mirrors

| 文件 | 改动 |
|---|---|
| `deploy/Dockerfile` | 9 处标记（2 个 `start/end` 块 + 3 处单行）：两个阶段的 apt 源改写、`ENV PIP_INDEX_URL`、cargo source replacement、三条 cargo `RUN` 上的 `--mount=type=cache` |

**先纠正一个容易读错的因果**：构建需要一个带出网代理的 buildx builder，这句仍然对，
但**它的作用范围只有 buildkitd 自己拉基础镜像**。
`RUN` 步骤里没有任何代理变量——实测在 `RUN` 里跑 `env | grep -i proxy` 是空的。
`--driver-opt env.HTTP_PROXY` 设的是 buildkitd 进程的环境，BuildKit 不会把它注入
build step。

所以在加这组镜像源之前，每一次 `apt` / `cargo` / `pip` 都是**直连**，而实测：

| 目标 | 容器内直连 |
|---|---|
| `deb.debian.org` | 917ms 延迟（一次 apt 装包实测跑了 939 秒） |
| `index.crates.io` | 1937ms |
| `static.crates.io`（真正下载 crate 的地方） | **不通** |
| `mirrors.ustc.edu.cn` / `rsproxy.cn` / `registry.npmmirror.com` | 47–125ms |

`static.crates.io` 不通就是 2026-08-25 那两次构建失败的真正原因：cargo 拉到 0 字节，
触发它默认的 `10 bytes / 30s` 阈值，报 `transfer too slow`。这个报错看起来像"网络慢"，
实际是"这个 host 根本连不上"。**加代理救不了它，因为 `RUN` 里本来就没有代理。**

改动内容：

- **apt 源 → `mirrors.ustc.edu.cn`**，backend 与最终镜像两个阶段各一处。
  **必须重写成 `http` 而不是 `https`**：最终镜像 `debian:bookworm-slim` 不带
  `ca-certificates`（它正是在改完源后那条 apt 里才装上的），改成 https 会让 apt 报
  `No system certificates available`。Debian 仓库自带签名、apt 会验签，http 就是基础
  镜像出厂时用的方案。这个坑踩过一次。
- **`ENV PIP_INDEX_URL`** 指向 ustc 的 pypi。用环境变量而不是给上游那条 `pip3` 补
  `-i`，为的是不动上游的 `RUN`。装的是 97.9MB 的 ziglang wheel。
- **cargo source replacement → `sparse+https://rsproxy.cn/index/`**，写在
  `$CARGO_HOME/config.toml`，位置必须在任何 cargo 联网动作之前。选 rsproxy 是因为它的
  `config.json` 里 `dl` 指向自己（`{"dl":"https://rsproxy.cn/api/v1/crates",...}`），
  index 和 crate 下载都不再碰不通的 `static.crates.io`。写之前会先检查基础镜像有没有
  自带 cargo 配置，有就硬失败要求手工合并，不悄悄覆盖。
- **三条 cargo `RUN` 加 `--mount=type=cache`**。上游给 pnpm 挂了 cache mount，却从没给
  cargo 挂过，所以失败重试要从零重下全部 crate。**只挂 `registry` 和 `git`，不能挂整个
  `$CARGO_HOME`**：`cargo install` 装出的 `cargo-zigbuild` 在 `$CARGO_HOME/bin`，那个
  必须留在镜像层里。两个编译步骤额外挂 `/app/target`，依赖编译是整个构建里最耗 CPU 的
  一步。**注意 `/app/target` 是 cache mount、不在镜像层里**，所以真实构建那条 `RUN`
  末尾把二进制 `cp` 到 `/out` 的动作必须留在同一条 `RUN` 内部——拆成单独的 `RUN` 会
  拿不到 `target/` 的内容。

**上游改动这几处时怎么办**：全部是附加改动，没有改上游的构建策略——arm64 交叉编译和
`cargo zigbuild` 都保留着。上游若重写 backend 阶段，按上面四条重新贴一遍即可。若上游
自己加了镜像源或 cargo cache mount，直接删掉本 fork 这几处，用上游的。

**注释一律写在 `RUN` 外面。** `RUN` 的 `\` 续行会把多行拼成一条 shell 命令，行内 `#`
注释可能把后面的内容一起吞掉（是否吞取决于 BuildKit 版本，不要赌）。本文件里那条
`rewritten` 校验就是这样差点被注释掉的。

**apt 源改写带一条防静默腐烂的校验**：`sed` 没匹配上不会报错，构建会静默退回直连、
慢到看起来像卡死。所以改完立刻 `grep` 确认，没匹配上就 `exit 1`。基础镜像换了源文件
布局（比如从 `sources.list` 改成 deb822 的 `.sources`）时会在这里停下来。

## 解冲突原则

- 冲突出现在下面「侵入上游文件的改动」列出的文件里 → 正常，按该条的「上游重写时怎么办」处理
- 冲突出现在其他文件 → 说明上游动了我们依赖的东西，先搞清楚上游改了什么，再决定
- 解完冲突后必须跑：`cargo test -p dbx-web` 和 `pnpm test`

### 测试基线（不知道这些会把正常的合并误判成回归）

截至 2026-08-25（上一次上游同步之后重新实测）：

- `cargo test -p dbx-web`：**144 passed / 0 failed**，必须全绿。（2026-08-13 时是 129，上游此后自己加了 15 个。）
- `pnpm test`：**有 9 个文件 / 72 个用例是既有失败**，全部是 happy-dom 没有实现
  `localStorage.removeItem` / `localStorage.clear` / `localStorage.getItem`，与本仓库的定制
  无关。只有超出这 9 个文件的失败才算回归：

  ```
  components/grid/__tests__/DataGridSurfaces.spec.ts              39
  components/meilisearch/__tests__/MeilisearchTasksPage.spec.ts    8
  lib/__tests__/sql/externalSqlFileTarget.spec.ts                  7
  components/mqtt/__tests__/MqttPublishDialog.spec.ts              6
  components/meilisearch/__tests__/MeilisearchKeysPage.spec.ts     5
  components/codeSnapshot/__tests__/CodeSnapshotDialog.spec.ts     4
  lib/meilisearch/meilisearchTaskColumns.spec.ts                   3
  lib/meilisearch/meilisearchKeyColumns.spec.ts                    3
  components/mqtt/__tests__/MqttAdminConsolePause.spec.ts          2
  ```

  2026-08-13 时这个清单只有前两个文件、28 个用例；上游此后新增的 spec 撞上了同一个
  happy-dom 缺口，数字才涨到 9 / 72。**这个清单会随上游继续变**，别把它当成一个固定
  数字。判断某个失败是不是上游自带的，可靠做法是把它放到纯上游上重跑一遍：

  ```bash
  git worktree add /tmp/upstream-wt upstream-main
  cd /tmp/upstream-wt && pnpm install --frozen-lockfile
  npx vitest run <那几个 spec 文件>
  git worktree remove --force /tmp/upstream-wt
  ```

  同一组文件在纯上游上也红，就是上游自带的。2026-08-25 这次同步正是这样确认的：
  合并后的 main 与纯 upstream-main 都是 9 个文件 / 72 个用例，逐字一致。
- **跑 `pnpm test` 之前先把 cargo 编译缓存热起来**（`cargo build --tests` 或 `cargo test -p dbx-web`）。`exportSmoke.spec.ts` 会在 `beforeAll` 里冷编译一个 Rust example，而 hook 超时固定 120 秒；只要有 Rust 改动导致重新编译，这个 spec 第一次就会假失败，重跑（缓存已热）就过。
- `pnpm typecheck` 和 `pnpm lint` 必须干净。`pnpm lint` 偶尔会 OOM 退出（`Linter process terminated abnormally`），那是环境问题，直接跑 `npx oxlint --vue-plugin apps/desktop/src` 即可。
