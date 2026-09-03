/**
 * preload: contextBridge で最小 API を renderer へ公開する（contextIsolation 前提）。
 * 型定義は src/shared/types.d.ts の TerminalAppApi を正とする。
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { ClickTarget, DropPayload, Snapshot, TerminalAppApi, ThemeSetting, WindowAction } from "../shared/types";

const api: TerminalAppApi = {
  getSnapshot: () => ipcRenderer.invoke("get-snapshot"),
  registerProjects: (paths: string[]) => ipcRenderer.invoke("register-projects", paths),
  registerDrop: (payload: DropPayload) => ipcRenderer.invoke("register-drop", payload),
  pickProjects: () => ipcRenderer.invoke("pick-projects"),
  dndLog: (msg: string) => ipcRenderer.send("dnd-log", msg),
  unregisterProject: (id: string) => ipcRenderer.invoke("unregister-project", id),
  setClickTarget: (id: string, target: ClickTarget) => ipcRenderer.invoke("set-click-target", id, target),
  setProjectStatus: (id: string, status: string | null) => ipcRenderer.invoke("set-project-status", id, status),
  setCustomStatuses: (list: string[]) => ipcRenderer.invoke("set-custom-statuses", list),
  setProjectName: (id: string, name: string) => ipcRenderer.invoke("set-project-name", id, name),
  setShowUnlinked: (value: boolean) => ipcRenderer.invoke("set-show-unlinked", value),
  setTheme: (theme: ThemeSetting) => ipcRenderer.invoke("set-theme", theme),
  setAlwaysOnTopDefault: (value: boolean) => ipcRenderer.invoke("set-aot-default", value),
  setPinned: (value: boolean) => ipcRenderer.invoke("set-pinned", value),
  focusProject: (id: string) => ipcRenderer.invoke("focus-project", id),
  showTileMenu: (id: string) => ipcRenderer.invoke("show-tile-menu", id),
  windowAction: (action: WindowAction) => ipcRenderer.send("window-action", action),
  notifyRendered: (revision: number) => ipcRenderer.send("notify-rendered", revision),
  onSnapshot: (cb: (snap: Snapshot) => void) => {
    ipcRenderer.on("snapshot", (_event, snap: Snapshot) => cb(snap));
  },
  onRenameRequest: (cb: (projectId: string) => void) => {
    ipcRenderer.on("rename-request", (_event, projectId: string) => cb(projectId));
  },
  // Electron 32+ では File.path が使えないため webUtils で D&D のパスを解決する（REQ-01）
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
};

contextBridge.exposeInMainWorld("terminalApp", api);
