import os from "node:os";

/**
 * 在 MCP 服务上注册 system_info 资源
 *
 * 提供操作系统/硬件信息
 */
export function registerSystemResource(server) {
  server.resource(
    "system_info",
    "system://info",
    async (uri) => {
      const info = {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        cpus: os.cpus().length,
        totalMemory: `${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB`,
        freeMemory: `${(os.freemem() / 1024 / 1024 / 1024).toFixed(2)} GB`,
        uptime: `${(os.uptime() / 3600).toFixed(1)} hours`,
        nodeVersion: process.version,
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(info, null, 2),
          },
        ],
      };
    },
  );
}
