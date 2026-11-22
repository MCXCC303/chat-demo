# chat-demo 本机服务

把 API Key、设置与会话记录收到本机一处，浏览器只当窗口：多个设备经 SSH 隧道访问同一个服务时共用同一份数据。

## 启动

一条命令同时拉起前端页面与接口，前端产物缺失时先构建：

```bash
pnpm server --port 8091
```

```
chat-demo: http://127.0.0.1:8091/?token=<入口密钥>
chat-demo: opening the default browser; pass --no-open to disable
```

命令行输出一律英文，与 DSH 一致；加 `--no-open` 不开浏览器，`--help` 看全部选项。

## 访问密钥

入口密钥每次启动重新生成，只在本机；用它打开上面的地址，服务会换成一枚带期限的会话 cookie，之后浏览器自动带上。

- 会话 cookie 默认有效 30 天（`--cookie-days` 可改），过期后需要再用入口密钥进入；
- 每次用入口密钥进入都会重新签发，时限随之重置；日常请求不续期；
- 签名密钥存在 `config/credentials.json` 的 `records` 里（0600），所以重启服务不需要重新进入；
- 入口密钥随进程更换：重启后旧地址失效，看新的命令行输出即可。

没有可用凭据时：入口密钥错误返回 401 并提示「reopen the URL printed by pnpm server」；其余受保护路径返回 401 `unauthorized`；来源不可信返回 403 `forbidden`。与 DSH v0.2.2 一致：换 cookie 的那一次请求不查信任栅栏，所以从别的站点点开带密钥的入口地址也能进入。

要回到「只靠回环栅栏、打开即用」：

```bash
pnpm server --port 8091 --no-auth
```

开发时前后端一起起，前端请求转发到后端：

```bash
pnpm dev:all --port 8090
```

## 参数

| 参数                     | 默认值                              | 含义                                                |
| ------------------------ | ----------------------------------- | --------------------------------------------------- |
| `--home`                 | `$CHAT_DEMO_HOME` 或 `~/.chat-demo` | 数据目录；显式参数优先于环境变量                    |
| `--port`                 | `8090`                              | 监听端口，0 表示由系统分配；也可用 `CHAT_DEMO_PORT` |
| `--host`                 | `127.0.0.1`                         | 监听地址                                            |
| `--upstream`             | `https://api.deepseek.com`          | 上游接口地址                                        |
| `--static`               | `dist-server`                       | 前端产物目录                                        |
| `--trust-host`           | 无                                  | 额外信任的主机名，可重复；默认只接受回环与监听地址  |
| `--build` / `--no-build` | 缺产物时构建                        | 是否在启动前构建前端                                |
| `--no-open`              | 默认打开浏览器                      | 不打开浏览器                                        |
| `--port-file`            | 无                                  | 把实际监听地址写入该文件                            |

## 目录

沿用 DSH 的分类：`config` 放配置与机密，`data` 放丢了就丢工作成果的记录，`state` 放可重建的索引，`cache` 放可重新下载的内容，`backup` 放备份。

```
~/.chat-demo/
  config/
    credentials.json      # API Key，只有属主可读（0600）
    settings.json         # 共享偏好
  data/
    sessions/<id>.json    # 会话详情
    files/<sha256>        # 附件原件，按内容寻址
    files/index.json      # 附件标识到内容的映射
  state/
  cache/
  backup/
```

## 接口

模型接口与 `api.deepseek.com` 同形，前端零改动：`/models`、`/anthropic/v1/messages`、`/anthropic/v1/files`、`/v1/tools/asr`、`/v1/tools/tts`。

存储接口由本机服务提供：`/api/status`、`/api/credential`、`/api/settings`、`/api/sessions`、`/api/files`。

凭据优先级：存储文件 > 启动环境 > 项目 `.env` > 数据目录下的 `.env`。改了文件下一次请求即生效，不用重启。

## 隧道访问

```bash
ssh -L 8090:127.0.0.1:8090 user@host
```

然后在任意设备的浏览器打开 `http://127.0.0.1:8090`，看到的是同一份数据。

服务只接受回环、绑定地址与显式信任的主机名；浏览器用的域名会原样出现在 Host 头里，所以用公网域名或反向代理访问时要声明信任：

```bash
pnpm server --port 8090 --trust-host frp-boy.com
```

`--trust-host` 写主机名则任意端口都放行，写 `主机名:端口` 则只放行该端口；可重复传入。

浏览器从地址栏、书签打开页面时发起方标记为 `none`，从别的站点跳转过来则是 `cross-site`；后者会被拒绝，请从地址栏打开。
