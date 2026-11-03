# agent-loop-studio

在 Claude Code 上运行的 agent 流程框架。**流程**（loop）负责调度**角色**：每一步由哪个角色做、按什么顺序、在什么条件下分支、最多重复几次、在哪里停下等 owner 决定。**角色**是一个 Claude Code agent 文件，只做一步。**会话**只负责启动流程、把 owner 的回答带进流程。流程之外没有任何调度，角色从不直接调用别的角色，owner 的每个决定都是流程里的一个 `owner-review` 步骤。

框架负责创建、复用和优化流程与角色：

- **Studio**：owner 在本机浏览器里用的控制台。在对话框里说想要什么，它马上列出相近的流程，每个都能预览流程图，并把最接近的画到画布上，超参数排在旁边、用虚线连到它们影响的步骤。点步骤或箭头、说要怎么改，`loop-authoring` 就在后台 Claude Code 会话里起草修改，改好后停下请你审核，草稿画在画布上。在这里还可以选定项目的主任务流程和超参数、运行任意流程并看着它一步步执行、在对话里修改角色，以及管理工作区里的多个项目：从参考项目新建，或复制已有项目。
- **基础角色和流程**：`loop-authoring`、`role-authoring`（以及 `loop-query`、`loop-editor`、`role-creator`），`owner-review`；`trajectory-optimizer` 根据轨迹修复角色；`project-memory` 记下做成了什么、没做成什么及原因；`task-manager` 是会话的角色；`library-contribution`（以及 `library-contributor`）在 owner 审过要发出的确切内容后，把项目学到的东西作为 PR 送回共享库。
- **检查**：`loop-check` 不调用模型，用假角色把流程脚本跑几遍、走到每个分支；角色文件检查优化器依赖的各节是否齐全。
- **hooks** 只做记录或拦截：每个结束的角色留下轨迹；交给流程的回答必须是 owner 在流程提问之后亲手输入的消息。

项目之间共享的流程和角色放在 [agent-loop-community](https://github.com/justforyou16007/agent-loop-community)。项目包用 git 子模块引用这两个仓库，版本由项目自己固定；它们从不反过来依赖任何项目。[auto-dl-loop](https://github.com/justforyou16007/auto-dl-loop)（双机研究任务）就是一个项目包。

## 安装一个项目

在本地仓库里（Node.js 22.12+）：

```bash
git clone https://github.com/justforyou16007/agent-loop-studio.git
cd agent-loop-studio
npm ci && npm run build
bash distribution/install-contrejour.sh --role default --project /path/to/project
```

安装器只写项目目录（`.contrejour/`、`.claude/`），不碰全局配置，也不下载任何东西。然后打开 Studio：

```bash
node /path/to/project/.contrejour/dist/tools/studio.js --project /path/to/project
```

它会打印一个一次性登录链接，在浏览器里打开即可。Studio 只在本机地址上响应；要在别的机器上用，先转发端口（`ssh -L 8790:127.0.0.1:8790 <机器>`）。先在项目里打开一次 `claude` 并接受信任提示：后台会话只在受信任的目录里启动。

要管理多个项目，就让 Studio 打开一个装着这些项目的目录，并指定这个仓库作为新项目的来源：

```bash
node dist/tools/studio.js --workspace ~/projects --library "$PWD"
```

## 项目包

基于框架的项目包在 `project.json` 里说明自己：有哪几种 profile（每种的会话入口角色、角色和流程来自流程库的哪几部分）、加了哪些 hook 动作，以及框架在需要项目决定的地方调用的扩展模块（怎样算"有任务完成"、哪些东西不能随贡献发出、贡献发出前要过的检查）。项目给框架角色的规则写在 `skills/shared-references/project-rules.md`。详见 [docs/architecture.md](docs/architecture.md)。

## 开发

```bash
npm ci
npm run build          # helper（tsc）和 Studio 页面（Vite）
npm run typecheck && npm run lint && npm run format:check
node tools/library-check.mjs
npm run test -- tests/test_project.ts
```

MIT 许可证。Studio 的界面风格用的是和 Dify 相同的开源组件（React、React Flow、Tailwind、Radix、lucide），没有使用 Dify 的代码。
