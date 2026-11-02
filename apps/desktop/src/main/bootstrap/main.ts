import { app, BrowserWindow } from "electron";
import { join } from "node:path";

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });

  window.once("ready-to-show", () => window.show());

  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl) {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

void app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
