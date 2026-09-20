const { contextBridge } = require("electron");
contextBridge.exposeInMainWorld("vncNetworkQA", JSON.parse(process.env.VNC_NETWORK_QA));
