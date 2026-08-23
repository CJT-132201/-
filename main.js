import { app, BrowserWindow } from 'electron';
import { startServer } from './index.js';
import { getConfig } from './lib/config.js';

// 启动后台服务(端口可被 .env 的 PORT 覆盖)
const PORT = process.env.PORT || 3000;
await startServer(PORT);

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 920,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    title: '桌面智能助手',
    autoHideMenuBar: true,
    backgroundColor: '#f7f7f8',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(`http://localhost:${PORT}`);

  // 用户在窗口里点关闭时,结束服务并退出
  win.on('closed', () => { win = null; });
}

app.whenReady().then(() => {
  const cfg = getConfig();
  console.log(`  ➜  模型: ${cfg.model}`);
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
