# agent-loop-studio

在 Claude Code 上运行的 agent 流程框架。**流程**（loop）负责调度**角色**：每一步由哪个角色做、按什么顺序、在什么条件下分支、最多重复几次、在哪里停下等 owner 决定。**角色**是一个 Claude Code agent 文件，只做一步。**会话**只负责启动流程、把 owner 的回答带进流程。流程之外没有任何调度，角色从不直接调用别的角色，owner 的每个决定都是流程里的一个 `owner-review` 步骤。

流程在 Studio 里编辑和运行，发布到社区库：

- **编辑态：Studio。** 每台机器装一次的应用，owner 在浏览器里用的控制台。它管理一个工作区里的多个项目：新建空项目、从框架示例或社区里已发布的项目新建、复制、打开。在对话框里说想要什么，它马上列出相近的流程，每个都能预览流程图，并把最接近的画到画布上，超参数排在旁边、用虚线连到它们影响的步骤。点步骤或箭头、说要怎么改，`loop-authoring` 在后台 Claude Code 会话里起草修改，改好后停下请你审核。在这里设置项目的 workflow（`setup`），把流程真跑一小轮试试（「试运行」，`loop-trial`），运行并看着它一步步执行，在对话里修改角色。项目做的优化（主要是根据轨迹修好的角色）留在项目里。
- **发布态：社区库。** 你决定时，「发布到社区」把整个项目作为示例放进 [agent-loop-community](https://github.com/justforyou16007/agent-loop-community)：项目是做什么的、运行哪个主任务流程和参数，以及项目自己的全部流程和角色。发出前你先审核确切内容，然后开一个 PR，由社区的维护者审核合并。别的机器上的 Studio 就能从它新建项目。
- **基础角色和流程**：`setup`（以及 `project-setup`）设置项目的 workflow：从合适的流程里找出符合你想法的主任务流程，按你的话修改或新建，定好参数，检查后交接。`loop-trial`（以及 `loop-tester`）按真实运行的方式检查一个流程：先静态检查，再真跑一小轮，请你判断是否符合目标，不符合就优化后再试。`publish`（以及 `project-publisher`，项目需要自查时还有 `publish-check`）发布项目。`loop-authoring`、`role-authoring`（以及 `loop-query`、`loop-editor`、`role-creator`），`owner-review`，`trajectory-optimizer`，`project-memory` 记下做成了什么、没做成什么及原因，`task-manager` 是会话的角色。
- **检查**：`loop-check` 不调用模型，用假角色把流程脚本跑几遍、走到每个分支；角色文件检查优化器依赖的各节是否齐全。
- **hooks** 只做记录或拦截：每个结束的角色留下轨迹；交给流程的回答必须是 owner 在流程提问之后亲手输入的消息。

## 安装 Studio

每台机器装一次，在本地仓库里（需要 Node.js 22.12+ 和 Claude Code）：

```bash
git clone https://github.com/justforyou16007/agent-loop-studio.git
cd agent-loop-studio
npm ci && npm run build
npm start
```

它会打印一个一次性登录链接，在浏览器里打开即可。Studio 只在本机地址上响应；要在别的机器上用，先转发端口（`ssh -L 8790:127.0.0.1:8790 <机器>`）。在 Windows 上，它会像终端一样去找 Claude Code（`claude.exe`，或者 npm 安装的 `claude.cmd`），找不到再通过 Git Bash 启动；也可以用 `--claude <路径>` 直接指定。项目放在一个工作区文件夹里，起初是 `~/agent-loop-projects`：在「项目」页点「切换工作区」可以浏览到别的文件夹或直接输入路径，Studio 会记住你选的，下次启动直接打开它（`--workspace <目录>` 或环境变量 `AGENT_LOOP_WORKSPACE` 优先于它）。

在「项目」页先获取一次社区库（克隆到本仓库旁边，git 会忽略它），然后新建项目：空项目、从框架示例或社区项目开始都可以；也可以复制项目，或者输入项目名确认后删除它（有流程还在里面运行时不能删）。项目文件夹由 Studio 建好，里面有 Claude Code 运行它需要的一切，你不用自己往里装任何东西。先在新项目的文件夹里打开一次 `claude` 并接受信任提示：后台会话只在受信任的目录里启动。从示例新建、还没设置的项目，打开时画布上是它的 `setup` 流程：点「运行」，它需要你决定时会在对话里问你。空项目打开时画布是空的：在对话里说说它要做什么，会找相近的流程或新建一个。框架自带的流程（包括 setup）在流程列表的「框架」一组里，和项目自己的分开。在对话框里输入 `@`（或点画布上的方块、箭头）可以引用步骤、箭头或参数；点对话里出现的角色、流程或步骤名，画布上会高亮它们、其余变灰；拖动对话栏的右边缘可以调宽度。「运行」旁边的「试运行」试跑画布上的流程；顶部的「发布到社区」发布这个项目。

## 项目包

在 Studio 里建的项目不需要额外的东西。为某一类特殊项目（多台机器协作、有自己的 helper、发布前要特殊检查）构建在框架上的项目包，在 `project.json` 里说明自己：有哪几种 profile（每种的会话入口角色、角色和流程来自流程库的哪几部分）、加了哪些 hook 动作，以及框架在需要项目决定的地方调用的扩展模块（怎样算"有任务完成"、哪些东西不能随发布发出、发布前要过的检查）。项目给框架角色的规则写在 `skills/shared-references/project-rules.md`。详见 [docs/architecture.md](docs/architecture.md)。

## 开发

```bash
npm ci
npm run build          # helper（tsc）和 Studio 页面（Vite）
npm run typecheck && npm run lint && npm run format:check
node tools/library-check.mjs
npm run test -- tests/test_project.ts
```

MIT 许可证。Studio 的界面风格用的是和 Dify 相同的开源组件（React、React Flow、Tailwind、Radix、lucide），没有使用 Dify 的代码。
