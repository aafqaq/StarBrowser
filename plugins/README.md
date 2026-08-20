# StarBrowser 声明式插件规范

StarBrowser 插件是 JSON 数据，不是可执行代码。插件引擎负责生命周期、权限、配置、请求、结果缓存与界面投影，插件只能组合引擎已经提供的能力。

## 分发与更新规则

- 在线目录固定为 `aafqaq/StarBrowser` 仓库的 `plugins/catalog.json`。
- 目录中的 `manifestUrl` 必须位于该仓库的 `raw.githubusercontent.com` 路径。
- 每次安装或更新都验证目录 SHA-256、插件 ID 和语义化版本。
- 在线更新禁止降级，配置会按新版 `settingsSchema` 重新校验并保留兼容项。
- 插件包使用临时文件与备份原子替换；新包或配置写入失败时恢复旧包。
- 本地导入仅接受不超过 256 KiB、通过同一清单校验器的 `.json` 文件。
- 新安装的软件没有任何已安装插件；仓库中的插件源码不会自动启用。

## 引擎钩子

| 钩子 | 用途 |
|---|---|
| `sessionMatch` | 按标签页主机名或目标域 Cookie 是否存在来识别隔离会话，不读取 Cookie 值。 |
| `schedule` | 使用插件设置决定 `onStartup` 或 `onInterval` 刷新。 |
| `refresh.steps` | 通过目标会话的 Electron Session 执行顺序只读 GET 请求，不创建 WebView。 |
| `refresh.outputs` | 从步骤响应中提取、转换有限的结果字段。 |
| `refresh.classify` | 将免费版等正常但不适用的结果与错误分开。 |
| `sessionBadges` | 把结果字段投影为会话卡片徽标或错误提示。 |

当前网络能力只允许 HTTPS、最多 8 个声明域名、最多 5 个顺序步骤、只读 GET、单响应 2 MiB、单请求最长 30 秒。请求不能越过 `permissions.hosts`，也不能访问 Node.js、文件系统、Electron API 或任意渲染代码。

## 最小结构

```json
{
  "schemaVersion": 1,
  "id": "example-plugin",
  "version": "1.0.0",
  "name": "示例插件",
  "description": "插件说明",
  "publisher": "Publisher",
  "permissions": {
    "hosts": ["https://example.com"],
    "capabilities": ["session.read-tabs", "session.fetch"]
  },
  "settingsSchema": [],
  "hooks": {
    "sessionMatch": { "tabHosts": ["example.com"] },
    "schedule": {
      "modeSetting": "updateMode",
      "startupValue": "startup",
      "intervalValue": "interval",
      "intervalSetting": "intervalHours"
    },
    "refresh": { "steps": [], "outputs": [], "classify": [] },
    "sessionBadges": []
  }
}
```

完整实现可参考 [`chatgpt-usage/plugin.json`](chatgpt-usage/plugin.json)。新增或更新插件后，需要同步修改目录版本与清单 SHA-256。
