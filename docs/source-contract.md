# 合作来源约定

## 资料边界

/groups/{name}/overview 给出 articleNumber、messageId、subject、bodyHref；同 messageId 的交叉发布共享正文身份。正文含 yEnc 子集 ybegin、ypart(begin/end，均1起含端点)、yend(size、pcrc32、crc32)，转义和换行按 docs/encoding.md。索引里的 fileSetId 才是资料集合身份，replacementOf 引用替代段，cancel 指向被撤回 messageId。文件名不是身份，缺失 whole CRC 不伪造整体验证。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/groups/repair/overview`，请求相对链接必须以实际来源地址解释。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不包含自动分页、协议解释或领域恢复策略。
