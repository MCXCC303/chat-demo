# 上游请求体 golden 基线与端到端回归

这套脚手架用真实的本地服务端和真实的浏览器界面跑一遍会话，把上游（Anthropic 兼容接口）收到的
`POST /anthropic/v1/messages` 请求体存成基线文件。重构「服务端持有会话真相、浏览器只做投影」之后，
只要再跑一次比对，就能证明发给上游的请求体逐字节没变。

## 组成

| 文件 | 作用 |
| --- | --- |
| `lib/mock-upstream.ts` | mock 上游：记录收到的请求体与请求头，按 Anthropic 协议回一段确定性的 SSE |
| `lib/browser.ts` | headless Chromium 驱动：用 node 内置 WebSocket 直连 CDP，不引入任何新依赖 |
| `lib/tcp-proxy.ts` | 浏览器与本地服务端之间的 TCP 代理，可以随时掐断连接 |
| `lib/app-server.ts` | 拉起仓库里的本地服务端（`server/src/index.ts`），把上游指向 mock |
| `scenarios.ts` | 场景集：发消息、重新生成、编辑后重发、续写、开启思考、开启智能搜索 |
| `run.ts` | 入口：采集模式、比对模式、断线续传检查 |
| `baseline/*.json` | 基线文件，每个场景一个 |

## 环境要求

- `/usr/bin/chromium`（可用 `E2E_CHROMIUM` 覆盖）
- Node 26 及以上（用到内置的 `fetch`、`WebSocket` 与 TypeScript 直接运行能力）
- 仓库根目录的 `node_modules` 已安装

## 跑法

```bash
# 采集基线：跑一遍全部场景，把上游请求体写进 tools/e2e/baseline/
node tools/e2e/run.ts capture

# 比对：重跑全部场景，与基线逐字节对比，不一致时打印差异并以非零码退出
node tools/e2e/run.ts compare

# 只跑一个场景
node tools/e2e/run.ts compare --scenario continue

# 断线续传检查：生成途中掐断浏览器到服务端的连接，验证内容不丢
node tools/e2e/run.ts disconnect

# 需要看着浏览器跑时加 --headful
node tools/e2e/run.ts capture --headful
```

首次运行如果还没有 `dist-server/`，脚本会先构建前端产物（`rspack build -c rspack.server.config.ts`）。

类型检查与格式：

```bash
node_modules/.bin/tsc -p tools/e2e/tsconfig.json
node_modules/.bin/oxfmt --write tools/e2e
```

## 基线文件格式

```json
{
  "scenario": "send",
  "title": "发送一条消息",
  "requests": [
    {
      "method": "POST",
      "path": "/anthropic/v1/messages",
      "headers": { "content-type": "application/json", "...": "..." },
      "body": "{\"model\":\"deepseek-flash\",...}"
    }
  ]
}
```

- `body` 是上游收到的原始字节（字符串），比对时逐字节比较，字段顺序变了也会被发现。
- 一个场景里出现的每一次上游请求都会按顺序记进 `requests`，例如「重新生成」有两条。
- `headers` 记录全部请求头，其中 `x-api-key`、`authorization` 写成 `<redacted>`，
  `host` 写成 `<upstream>`（端口每次随机，没有比较价值）。

## 比对范围

- **请求体**：逐字节比较，任何差异都会打印基线与本次的逐行差异。
- **请求头**：只比较 `content-type`、`accept`、`anthropic-beta` 三项。
  `host`、`content-length`、`user-agent`、`accept-encoding` 这些随运行环境变化，不参与比较。
- **请求条数**：条数不一致直接算失败。

## 确定性从哪来

基线要能跨天、跨机器复用，所以脚本把会漂的东西都钉住了：

- 浏览器里 `Date` 被冻结到 `2025-12-01T00:00:00Z`，时区固定为 UTC，
  请求体里的 `latest_reminder` 因此不会随日期变化。
- 语言固定为 `zh-CN`（localStorage 与服务端 `/api/settings` 双向对齐），界面文案与提醒语种稳定。
- 位置不设置，`latest_reminder` 里的地区为空。
- 每个场景用独立的浏览器上下文、独立的本地服务端数据目录（临时目录，跑完即删），
  互不串味；思考与搜索开关在每个场景开始前通过 `PUT /api/settings` 复位。
- mock 上游的回复是固定文本、固定分块，时长与 token 用量都是常数。

## 断线续传检查

`node tools/e2e/run.ts disconnect` 会在浏览器与本地服务端之间插入一层 TCP 代理：
浏览器连的是代理，代理再转发给本地服务端。生成途中调用 `proxy.cut()` 把所有连接掐断，
随后检查两件事：

1. 页面上的回答仍然包含全部 20 个分块，即断线没有丢内容；
2. 浏览器重新发起了 `GET /api/turns/<id>/events` 订阅，即按 seq 续订而不是从头重来。

## 用法建议

重构之前先在旧实现上 `capture` 一份基线并提交，重构之后 `compare`。
只要退出码是 0，就说明提示词、模型参数、工具声明、思考与搜索开关、发给上游的请求体都没变。
基线是逐字节的，任何"顺手改一下"的字段调整都会被立刻发现。
