import { crashReporter } from "electron";
import type { AppPaths } from "./paths";

export function startCrashReporter(paths: AppPaths): void {
  crashReporter.start({
    productName: "Maia LLM",
    companyName: "texano00",
    submitURL: "",
    uploadToServer: false,
    compress: true,
    extra: {
      logsDir: paths.logsDir
    }
  });
}
