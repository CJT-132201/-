# 🖥️ 桌面智能助手

一个 **双击打开、独立窗口** 的 AI 助手,能让 AI"用你的电脑"。支持**自定义模型和 API**,无需改代码,界面上直接填。

## 🚀 怎么用(三步)

### 1. 双击启动
双击桌面上的 **`启动桌面助手.bat`**
- 它会自动启动后台服务,并打开一个**独立的 AI 应用窗口**(没有浏览器地址栏,像原生 App)。

### 2. 填模型配置
打开后如果提示"未配置",点右上角 **⚙ 齿轮按钮**:
- **API 密钥 (Key)** —— 填入你的 DeepSeek / 其他兼容服务的 Key
- **接口地址 (Base URL)** —— 默认 `https://api.deepseek.com`,可换成任意 OpenAI 兼容服务
- **模型名 (Model)** —— 默认 `deepseek-chat`
- 点 **保存** 即可

### 3. 开始对话
在下方输入,例如:
- `帮我列出 agent-home 目录下的文件`
- `帮我建一个 test 文件夹`
- `帮我写一个 hello.py`

## 🛡️ 安全说明

- **危险命令** 会被直接拦截(强制删除、格式化、关机、改系统盘等)。
- **高危操作**(删除/下载/移动等)会 **弹出确认框**,你点"确认"才执行。
- AI 的操作默认被限制在 `agent-home` 文件夹内。

## 🛑 停止
双击桌面的 **`停止助手.bat`** 即可关闭后台服务。

## ⚙️ 常用配置(可选)

不想在界面里填?也可以直接改 `config.json`:
```json
{
  "apiKey": "sk-你的密钥",
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-chat",
  "allowShell": true,
  "requireConfirm": true
}
```

## 📁 目录
```
桌面智能助手/
├── 启动桌面助手.bat   # 双击启动
├── 停止助手.bat       # 双击停止
├── index.js           # 主程序
├── lib/tools.js       # 工具 + 安全拦截
├── lib/config.js      # 配置读写
├── public/index.html  # 应用界面(含设置面板)
├── config.json        # 模型/API 配置
└── agent-home/        # AI 的工作目录
```
