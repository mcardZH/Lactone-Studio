// The confirmed portable-package setup prompt (cross-platform: macOS, Linux, and Windows).
export const ES_MCP_SETUP_PROMPT = String.raw`我的 Lactone Studio (ES) 位置 <填写应用路径：macOS 为 Lactone Studio.app，Linux 为解压目录或可执行文件，Windows 为解压目录或 Ester-Studio.exe / Lactone-Studio.exe>

请把这套 Lactone Studio（基于 Ester Studio 的非官方修改版）接入你当前运行的本机 Agent，MCP 服务名为 ester_studio。请直接完成配置和连接验证。若我还没有提供路径，请向我索取这一项。

1. 确定安装目录。若提供的是 macOS .app 包（如 /Applications/Lactone Studio.app），应用包内可复用相同命令行。保留路径中的空格和中文。若提供的是压缩包，请先提示解压后的路径。
2. 核对 MCP 入口（推荐优先使用设置 -> AI 协作 (MCP) 中的本地 HTTP/SSE 或 Stdio 配置；若使用 mcpHost 适配器 stdio.cjs）：
   - macOS（.app 包）：command 为 <App>.app/Contents/MacOS/Lactone Studio（或实际可执行文件名），args 第一项为 <App>.app/Contents/Resources/app/desktop/mcp/stdio.cjs，环境变量 ELECTRON_RUN_AS_NODE=1；默认 ES_MCP_DISCOVERY_DIR 为 ~/Library/Application Support/Lactone Studio/MCP/v1。
   - Linux：command 为安装目录下的主可执行文件，args 第一项为同级 resources/app/desktop/mcp/stdio.cjs，环境变量 ELECTRON_RUN_AS_NODE=1；默认 ES_MCP_DISCOVERY_DIR 为 ~/.local/share/Lactone Studio/MCP/v1。
   - Windows：command 为 runtime\Ester-Studio-host.exe（或对应 host 可执行文件），args 第一项为 runtime\resources\app\desktop\mcp\stdio.cjs，环境变量 ELECTRON_RUN_AS_NODE=1；默认 ES_MCP_DISCOVERY_DIR 为 %LOCALAPPDATA%\Lactone Studio\MCP\v1。
   确认启动程序和脚本实际存在后再写配置；若找不到入口，请说明实际查到的路径情况。
3. 配置当前客户端。按你当前版本支持的本地 stdio/HTTP MCP 配置方式，优先登记到用户级，让后续新会话也能使用。只新增或更新 ester_studio（或 lactone-studio）这一项。更新时沿用已有客户端标识，新登记时使用当前客户端的稳定标识。stdio.cjs 支持 --client <name> 参数指定标识。
4. 验证连接。若使用 stdio.cjs（mcpHost），请先调用 es_connect({}) 连接现有窗口（未启动时适配器会自动拉起同一安装目录的应用）；若使用 Streamable HTTP / stdio-server.cjs，可直接调用 ester_ping 和 es_context。首次连接 mcpHost 时请提醒我回到目标窗口点击「仅本次」或「记住此客户端」。通过后调用 es_context 报告当前项目与模型；若有多个窗口请列出候选供我选择。

请按实际结果告知进展，并以 es_context 的实际回执作为连接成功的依据。`;
